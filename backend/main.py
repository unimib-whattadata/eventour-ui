from __future__ import annotations

import csv
import io
import json
import os
import re
from pathlib import Path
from typing import Any
from urllib import parse
from urllib import error, request

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict this to your frontend's URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
POIS_FILENAME = "pois_with_wikidata.csv"
DISTANCES_FILENAME = "poi_distances.csv"
DISTANCE_FIELDNAMES = [
    "From_POI",
    "From_Type",
    "From_Label",
    "To_POI",
    "To_Type",
    "To_Label",
    "Distance (m)",
    "Duration (s)",
]


class CercaItinerariPayload(BaseModel):
    nodo_partenza: str
    nodo_arrivo: str
    filtri: list[str] = []
    max_stop_intermedi: int = Field(ge=0, le=10)
    tempo_massimo_minuti: int = Field(ge=0)


class SparqlQueryPayload(BaseModel):
    query: str = Field(min_length=1)
    timeout_seconds: int = Field(default=90, ge=10, le=300)


def _load_env_from_file() -> None:
    candidates = [
        PROJECT_ROOT / ".env",
        BASE_DIR / ".env",
        Path.cwd() / ".env",
    ]

    for env_path in candidates:
        if not env_path.exists() or not env_path.is_file():
            continue
        try:
            lines = env_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            raw = line.strip()
            if not raw or raw.startswith("#") or "=" not in raw:
                continue
            key, value = raw.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


def _resolve_data_file(filename: str) -> Path:
    candidates = [
        PROJECT_ROOT / filename,
        BASE_DIR / filename,
        Path("/data") / filename,
        Path("/workspace") / filename,
        Path.cwd() / filename,
    ]
    for file_path in candidates:
        if file_path.is_file():
            return file_path
    raise FileNotFoundError(
        f"File '{filename}' not found. Checked paths: {', '.join(str(path) for path in candidates)}"
    )


def _safe_float(value: str | None) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _normalize_type(value: str | None) -> str:
    raw = value or ""
    return re.sub(r"[^a-z0-9]+", "", raw.casefold())


def _load_pois() -> list[dict[str, Any]]:
    pois_file = _resolve_data_file(POIS_FILENAME)
    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    with pois_file.open(newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            poi_id = (row.get("POI") or "").strip()
            if not poi_id or poi_id in seen:
                continue
            seen.add(poi_id)

            place = (row.get("PLACE") or row.get("place") or "").strip()
            label = (row.get("label") or place or f"POI {poi_id}").strip()
            poi_type = (row.get("TYPE") or "").strip()
            items.append(
                {
                    "poi_id": poi_id,
                    "label": label,
                    "type": poi_type,
                    "place": place,
                    "latitude": _safe_float(row.get("LATITUDE")),
                    "longitude": _safe_float(row.get("LONGITUDE")),
                }
            )

    items.sort(key=lambda poi: (poi["label"].lower(), poi["poi_id"]))
    return items


def _load_distance_rows() -> list[dict[str, str]]:
    distances_file = _resolve_data_file(DISTANCES_FILENAME)
    with distances_file.open(newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        return [
            {field: (row.get(field) or "").strip()
             for field in DISTANCE_FIELDNAMES}
            for row in reader
        ]


def _filter_distance_rows(
    rows: list[dict[str, str]],
    selected_filters: list[str],
    start_node: str,
    end_node: str,
) -> list[dict[str, str]]:
    filters = {_normalize_type(item) for item in selected_filters if item.strip()}
    if not filters:
        return rows

    filtered_rows: list[dict[str, str]] = []
    for row in rows:
        from_type = _normalize_type(row["From_Type"])
        to_type = _normalize_type(row["To_Type"])
        from_poi = row["From_POI"]
        to_poi = row["To_POI"]

        must_keep_for_endpoints = (
            from_poi == start_node
            or to_poi == start_node
            or from_poi == end_node
            or to_poi == end_node
        )
        matches_filter = from_type in filters or to_type in filters

        if matches_filter and not must_keep_for_endpoints:
            continue
        filtered_rows.append(row)

    return filtered_rows


def _rows_to_csv_text(rows: list[dict[str, str]]) -> str:
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=DISTANCE_FIELDNAMES)
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


def _to_sparql_cell(binding: Any) -> str:
    if not isinstance(binding, dict):
        return ""
    value = str(binding.get("value", ""))
    if not value:
        return ""
    lang = binding.get("xml:lang")
    datatype = binding.get("datatype")
    if lang:
        return f"{value} @{lang}"
    if datatype:
        return f"{value} ^^ {datatype}"
    return value


def _resolve_graphdb_query_endpoint() -> str:
    configured = os.getenv(
        "GRAPHDB_SPARQL_ENDPOINT",
        "https://eventour-graphdb.whattadata.it/sparql?repositoryId=eventour",
    )
    parsed = parse.urlsplit(configured)
    query_params = parse.parse_qs(parsed.query)
    repo_id = (
        query_params.get("repositoryId")
        or query_params.get("repository")
        or [None]
    )[0]
    if repo_id and parsed.path.rstrip("/").endswith("/sparql"):
        base_path = parsed.path.rstrip("/")
        new_path = f"{base_path[: -len('/sparql')]}/repositories/{repo_id}"
        return parse.urlunsplit((parsed.scheme, parsed.netloc, new_path, "", ""))
    return configured


def _normalize_sparql_query(query: str) -> str:
    # Accept shorthand like: GRAPH http://example.org/graph { ... }
    # and convert it to valid SPARQL IRI syntax:
    # GRAPH <http://example.org/graph> { ... }
    return re.sub(
        r"(?i)(\bGRAPH\s+)(https?://[^\s\{\}>]+)",
        r"\1<\2>",
        query,
    )


def _call_graphdb_sparql(query: str, timeout_seconds: int) -> dict[str, Any]:
    endpoint = _resolve_graphdb_query_endpoint()
    form_body = parse.urlencode({"query": query}).encode("utf-8")
    headers = {
        "Accept": "application/sparql-results+json",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    }

    def _read_response(req: request.Request) -> str:
        with request.urlopen(req, timeout=timeout_seconds) as response:
            return response.read().decode("utf-8", errors="replace")

    try:
        post_request = request.Request(
            url=endpoint,
            data=form_body,
            method="POST",
            headers=headers,
        )
        raw = _read_response(post_request)
    except error.HTTPError as post_exc:
        post_detail = post_exc.read().decode("utf-8", errors="replace")
        if post_exc.code != 405:
            raise HTTPException(
                status_code=502,
                detail=f"GraphDB returned error {post_exc.code}: {post_detail}",
            ) from post_exc

        # Some deployments expose read-only SPARQL endpoints that accept GET only.
        separator = "&" if "?" in endpoint else "?"
        get_url = f"{endpoint}{separator}{parse.urlencode({'query': query})}"
        try:
            get_request = request.Request(
                url=get_url,
                method="GET",
                headers={"Accept": "application/sparql-results+json"},
            )
            raw = _read_response(get_request)
        except error.HTTPError as get_exc:
            detail = get_exc.read().decode("utf-8", errors="replace")
            raise HTTPException(
                status_code=502,
                detail=f"GraphDB returned error {get_exc.code}: {detail}",
            ) from get_exc
    except error.URLError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Unable to reach GraphDB: {exc.reason}",
        ) from exc

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Non-JSON response from GraphDB: {raw[:1000]}",
        ) from exc


def _build_gemini_prompt(payload: CercaItinerariPayload, filtered_rows: list[dict[str, str]]) -> str:
    max_total_stops = payload.max_stop_intermedi + 2
    duration_seconds = payload.tempo_massimo_minuti * 60
    duration_rule = (
        f"La durata totale del percorso deve essere <= {payload.tempo_massimo_minuti} minuti ({duration_seconds} secondi)."
        if payload.tempo_massimo_minuti > 0
        else "Non c'e limite di durata totale."
    )

    table_text = _rows_to_csv_text(filtered_rows)
    return f"""
Sei un route planner.
Devi proporre uno o piu percorsi interessanti usando ESCLUSIVAMENTE i dati della tabella CSV allegata.

Input:
- nodo_partenza: {payload.nodo_partenza}
- nodo_arrivo: {payload.nodo_arrivo}
- max_stop_intermedi: {payload.max_stop_intermedi}
- max_nodi_totali_compresi_partenza_arrivo: {max_total_stops}
- tempo_massimo_minuti: {payload.tempo_massimo_minuti}
- filtri_attivi: {payload.filtri}

Regole obbligatorie:
1. Ogni percorso deve partire da nodo_partenza e arrivare a nodo_arrivo.
2. Usa solo collegamenti presenti in tabella (From_POI -> To_POI).
3. {duration_rule}
4. Il numero massimo di stop intermedi e {payload.max_stop_intermedi}. Quindi i nodi totali per percorso non possono superare {max_total_stops}.
5. Se non trovi percorsi validi restituisci solo una riga vuota.
6. Restituisci AL MASSIMO 3 itinerari (ideale 2 o 3), ordinati dal piu interessante al meno interessante.
7. Non troncare mai gli ID dei nodi: ogni ID deve essere completo.
8. Non limitarti a percorsi con pochi stop: quando i vincoli lo permettono, includi almeno un percorso con molti stop intermedi (vicino al massimo consentito).
9. Includi itinerari con stop intermedi variabili, non solo percorsi diretti o con 1 stop.

Formato output obbligatorio (nessun testo extra):
<id-nodo> - <id-nodo> - <id-nodo>
<id-nodo> - <id-nodo>

Tabella CSV filtrata:
{table_text}
""".strip()


def _call_gemini(prompt: str) -> str:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail=(
                "Gemini API key is missing. Set GEMINI_API_KEY "
                "in environment variables."
            ),
        )

    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "topP": 0.9, "maxOutputTokens": 1200},
    }

    primary_model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    fallback_models = [
        model.strip()
        for model in os.getenv("GEMINI_MODEL_FALLBACKS", "gemini-2.5-flash-lite").split(",")
        if model.strip()
    ]
    models_to_try = [
        primary_model, *[model for model in fallback_models if model != primary_model]]

    payload: dict[str, Any] | None = None
    last_unavailable_detail = ""
    generic_error_message = (
        "Route calculation service is temporarily unavailable. Please try again in a few moments."
    )

    for model in models_to_try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        req = request.Request(
            url=url,
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json",
                     "x-goog-api-key": api_key},
        )

        try:
            with request.urlopen(req, timeout=90) as response:
                payload = json.loads(response.read().decode("utf-8"))
                break
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            if exc.code in (429, 503):
                last_unavailable_detail = detail
                continue
            print(
                f"Gemini HTTP error on model {model}: code={exc.code}, detail={detail[:1000]}",
                flush=True,
            )
            raise HTTPException(
                status_code=502,
                detail=generic_error_message,
            ) from exc
        except error.URLError as exc:
            print(
                f"Gemini URL error on model {model}: reason={exc.reason}",
                flush=True,
            )
            raise HTTPException(
                status_code=502,
                detail=generic_error_message,
            ) from exc

    if payload is None:
        print(
            "Gemini unavailable for all attempted models: "
            f"{', '.join(models_to_try)} | detail={last_unavailable_detail[:1000]}",
            flush=True,
        )
        raise HTTPException(
            status_code=503,
            detail=generic_error_message,
        )

    text_parts: list[str] = []
    for candidate in payload.get("candidates", []):
        for part in candidate.get("content", {}).get("parts", []):
            text = part.get("text")
            if text:
                text_parts.append(text)

    if not text_parts:
        print(
            f"Gemini returned no text payload: {json.dumps(payload)[:1200]}",
            flush=True,
        )
        raise HTTPException(
            status_code=502,
            detail=generic_error_message,
        )

    return "\n".join(text_parts).strip()


def _extract_paths(llm_response: str, max_paths: int = 3) -> list[list[str]]:
    routes: list[list[str]] = []
    seen_routes: set[tuple[str, ...]] = set()
    for raw_line in llm_response.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        # Strip only bullets/enumeration markers without removing the first POI id.
        line = re.sub(r"^[\-\*\u2022\s]+", "", line)
        line = re.sub(r"^\d+\s*[\)\.]\s*", "", line)
        if "-" not in line:
            continue
        nodes = [node.strip() for node in line.split("-") if node.strip()]
        if len(nodes) < 2:
            continue
        if not all(re.fullmatch(r"\d+", node) for node in nodes):
            continue
        node_tuple = tuple(nodes)
        if node_tuple in seen_routes:
            continue
        routes.append(nodes)
        seen_routes.add(node_tuple)
        if len(routes) >= max_paths:
            break
    return routes


def _build_edge_lookup(rows: list[dict[str, str]]) -> dict[tuple[str, str], float]:
    edge_lookup: dict[tuple[str, str], float] = {}

    def _set_edge(from_poi: str, to_poi: str, duration_seconds: float) -> None:
        edge_key = (from_poi, to_poi)
        existing = edge_lookup.get(edge_key)
        if existing is None or duration_seconds < existing:
            edge_lookup[edge_key] = duration_seconds

    for row in rows:
        from_poi = row["From_POI"]
        to_poi = row["To_POI"]
        if not from_poi or not to_poi:
            continue
        duration_seconds = _safe_float(row.get("Duration (s)"))
        if duration_seconds is None:
            continue

        # The distance table is used as graph connectivity and can be traversed both ways.
        _set_edge(from_poi, to_poi, duration_seconds)
        _set_edge(to_poi, from_poi, duration_seconds)
    return edge_lookup


def _augment_paths_with_long_candidate(
    candidate_paths: list[list[str]],
    filtered_rows: list[dict[str, str]],
    start_node: str,
    end_node: str,
    max_stop_intermedi: int,
    tempo_massimo_minuti: int,
) -> list[list[str]]:
    if max_stop_intermedi <= 2:
        return candidate_paths

    current_max_stops = 0
    for nodes in candidate_paths:
        if nodes and nodes[0] == start_node and nodes[-1] == end_node:
            current_max_stops = max(current_max_stops, max(0, len(nodes) - 2))

    if current_max_stops >= min(max_stop_intermedi, 3):
        return candidate_paths

    edge_lookup = _build_edge_lookup(filtered_rows)
    direct_duration = edge_lookup.get((start_node, end_node))
    if direct_duration is None:
        return candidate_paths

    nodes_pool: set[str] = set()
    for row in filtered_rows:
        from_poi = row.get("From_POI") or ""
        to_poi = row.get("To_POI") or ""
        if from_poi:
            nodes_pool.add(from_poi)
        if to_poi:
            nodes_pool.add(to_poi)

    nodes_pool.discard(start_node)
    nodes_pool.discard(end_node)

    tempo_massimo_secondi = tempo_massimo_minuti * 60
    path = [start_node, end_node]
    total_duration = direct_duration

    while len(path) - 2 < max_stop_intermedi:
        best_insertion: tuple[float, int, str, float] | None = None

        for candidate_node in nodes_pool:
            if candidate_node in path:
                continue

            for index in range(len(path) - 1):
                from_node = path[index]
                to_node = path[index + 1]
                segment_duration = edge_lookup.get((from_node, to_node))
                add_first = edge_lookup.get((from_node, candidate_node))
                add_second = edge_lookup.get((candidate_node, to_node))

                if (
                    segment_duration is None
                    or add_first is None
                    or add_second is None
                ):
                    continue

                delta = add_first + add_second - segment_duration
                next_total = total_duration + delta
                if tempo_massimo_secondi > 0 and next_total > tempo_massimo_secondi:
                    continue

                if best_insertion is None or delta < best_insertion[0]:
                    best_insertion = (delta, index + 1, candidate_node, next_total)

        if best_insertion is None:
            break

        _, insert_at, node_to_insert, updated_total = best_insertion
        path.insert(insert_at, node_to_insert)
        total_duration = updated_total

    if len(path) <= 2:
        return candidate_paths

    existing = {tuple(route) for route in candidate_paths}
    if tuple(path) in existing:
        return candidate_paths

    # Prefer showing the longer valid route first.
    return [path, *candidate_paths][:3]


def _build_itineraries(
    candidate_paths: list[list[str]],
    start_node: str,
    end_node: str,
    filtered_rows: list[dict[str, str]],
    poi_index: dict[str, dict[str, Any]],
    max_stop_intermedi: int,
    tempo_massimo_minuti: int,
) -> list[dict[str, Any]]:
    edge_lookup = _build_edge_lookup(filtered_rows)
    itineraries: list[dict[str, Any]] = []
    max_total_nodes = max_stop_intermedi + 2
    tempo_massimo_secondi = tempo_massimo_minuti * 60

    for nodes in candidate_paths:
        if not nodes or nodes[0] != start_node or nodes[-1] != end_node:
            continue
        if len(nodes) > max_total_nodes:
            continue

        total_duration_seconds = 0.0
        valid_path = True

        for idx in range(len(nodes) - 1):
            duration_seconds = edge_lookup.get((nodes[idx], nodes[idx + 1]))
            if duration_seconds is None:
                valid_path = False
                break
            total_duration_seconds += duration_seconds

        if not valid_path:
            continue
        if tempo_massimo_secondi > 0 and total_duration_seconds > tempo_massimo_secondi:
            continue

        points: list[dict[str, Any]] = []
        for node_id in nodes:
            poi = poi_index.get(node_id)
            if poi is None:
                valid_path = False
                break
            points.append(
                {
                    "poi_id": poi["poi_id"],
                    "label": poi["label"],
                    "type": poi["type"],
                    "place": poi["place"],
                    "latitude": poi["latitude"],
                    "longitude": poi["longitude"],
                }
            )

        if not valid_path:
            continue

        itineraries.append(
            {
                "percorso": " - ".join(nodes),
                "nodi": nodes,
                "tempo_totale_secondi": round(total_duration_seconds, 1),
                "tempo_totale_minuti": round(total_duration_seconds / 60.0, 1),
                "stop_intermedi_totali": max(0, len(nodes) - 2),
                "punti_totali": len(nodes),
                "punti": points,
            }
        )

        if len(itineraries) >= 3:
            break

    return itineraries


_load_env_from_file()


@app.get("/health")
def healthcheck() -> dict[str, str]:
    return {"status": "ok", "message": "Backend is running"}


@app.get("/")
def read_root() -> dict[str, str]:
    return {"message": "Welcome to FastAPI Backend"}


@app.get("/pois")
def get_pois() -> dict[str, Any]:
    pois = _load_pois()
    return {"count": len(pois), "items": pois}


@app.post("/sparql/query")
def sparql_query(payload: SparqlQueryPayload) -> dict[str, Any]:
    query = payload.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="The SPARQL query cannot be empty.")
    normalized_query = _normalize_sparql_query(query)

    graphdb_payload = _call_graphdb_sparql(
        query=normalized_query,
        timeout_seconds=payload.timeout_seconds,
    )
    endpoint = _resolve_graphdb_query_endpoint()

    if "boolean" in graphdb_payload:
        boolean_value = bool(graphdb_payload.get("boolean"))
        return {
            "status": "ok",
            "message": "Query executed successfully.",
            "endpoint": endpoint,
            "result_type": "ask",
            "columns": ["result"],
            "rows": [{"result": "true" if boolean_value else "false"}],
            "row_count": 1,
            "query": query,
            "query_executed": normalized_query,
        }

    vars_list = graphdb_payload.get("head", {}).get("vars", [])
    if not isinstance(vars_list, list):
        vars_list = []

    bindings = graphdb_payload.get("results", {}).get("bindings", [])
    if not isinstance(bindings, list):
        bindings = []

    rows: list[dict[str, str]] = []
    for binding in bindings:
        if not isinstance(binding, dict):
            continue
        row: dict[str, str] = {}
        for variable in vars_list:
            var_name = str(variable)
            row[var_name] = _to_sparql_cell(binding.get(var_name))
        rows.append(row)

    return {
        "status": "ok",
        "message": "Query executed successfully.",
        "endpoint": endpoint,
        "result_type": "select",
        "columns": [str(var_name) for var_name in vars_list],
        "rows": rows,
        "row_count": len(rows),
        "query": query,
        "query_executed": normalized_query,
    }


@app.post("/cerca-itinerari")
def cerca_itinerari(payload: CercaItinerariPayload) -> dict[str, Any]:
    pois = _load_pois()
    poi_ids = {poi["poi_id"] for poi in pois}
    poi_index = {poi["poi_id"]: poi for poi in pois}
    if payload.nodo_partenza not in poi_ids:
        raise HTTPException(
            status_code=400, detail="Start node is not present in pois_with_wikidata.csv")
    if payload.nodo_arrivo not in poi_ids:
        raise HTTPException(
            status_code=400, detail="Destination node is not present in pois_with_wikidata.csv")

    distance_rows = _load_distance_rows()
    filtered_rows = _filter_distance_rows(
        rows=distance_rows,
        selected_filters=payload.filtri,
        start_node=payload.nodo_partenza,
        end_node=payload.nodo_arrivo,
    )

    if not filtered_rows:
        raise HTTPException(
            status_code=400,
            detail="The filtered table is empty. Try reducing filters.",
        )

    prompt = _build_gemini_prompt(payload=payload, filtered_rows=filtered_rows)
    llm_response = _call_gemini(prompt)
    raw_paths = _extract_paths(llm_response, max_paths=3)
    raw_paths = _augment_paths_with_long_candidate(
        candidate_paths=raw_paths,
        filtered_rows=filtered_rows,
        start_node=payload.nodo_partenza,
        end_node=payload.nodo_arrivo,
        max_stop_intermedi=payload.max_stop_intermedi,
        tempo_massimo_minuti=payload.tempo_massimo_minuti,
    )
    itineraries = _build_itineraries(
        candidate_paths=raw_paths,
        start_node=payload.nodo_partenza,
        end_node=payload.nodo_arrivo,
        filtered_rows=filtered_rows,
        poi_index=poi_index,
        max_stop_intermedi=payload.max_stop_intermedi,
        tempo_massimo_minuti=payload.tempo_massimo_minuti,
    )
    paths = [itinerary["percorso"] for itinerary in itineraries]

    status = "ok" if itineraries else "no_routes"
    message = (
        f"Found {len(itineraries)} routes."
        if itineraries
        else "No routes found with the selected constraints."
    )

    return {
        "status": status,
        "message": message,
        "input": payload.model_dump(),
        "source_rows": len(distance_rows),
        "filtered_rows": len(filtered_rows),
        "paths_count": len(paths),
        "paths": paths,
        "raw_paths": [" - ".join(path) for path in raw_paths],
        "itinerari": itineraries,
        "llm_response": llm_response,
    }
