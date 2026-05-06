import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Edge,
  MarkerType,
  MiniMap,
  Node,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { LoaderCircle } from "lucide-react";

type Theme = "light" | "dark";
type RequestState = "idle" | "loading" | "success" | "error";
type OntologyNodeKind =
  | "class"
  | "property"
  | "scheme"
  | "concept"
  | "external";
type OntologyEdgeRelation =
  | "subClassOf"
  | "domain"
  | "range"
  | "inScheme"
  | "hasTopConcept";

type OntologyNodeData = {
  label: string;
  kind: OntologyNodeKind;
  compactUri: string;
};

type OntologyEdgeData = {
  relation: OntologyEdgeRelation;
};

type OntologyStats = {
  triples: number;
  classes: number;
  properties: number;
  conceptSchemes: number;
  concepts: number;
  edges: number;
};

type OntologyGraphModel = {
  nodes: Node<OntologyNodeData>[];
  edges: Edge<OntologyEdgeData>[];
  stats: OntologyStats;
};

type OntologyPageProps = {
  theme: Theme;
};

type NtObject =
  | { kind: "uri"; value: string }
  | { kind: "literal"; value: string; language?: string }
  | { kind: "blank"; value: string }
  | { kind: "unknown"; value: string };

type NtTriple = {
  subject: string;
  predicate: string;
  object: NtObject;
};

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDF_PROPERTY = "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property";
const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const RDFS_SUBCLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const RDFS_DOMAIN = "http://www.w3.org/2000/01/rdf-schema#domain";
const RDFS_RANGE = "http://www.w3.org/2000/01/rdf-schema#range";
const OWL_CLASS = "http://www.w3.org/2002/07/owl#Class";
const OWL_OBJECT_PROPERTY = "http://www.w3.org/2002/07/owl#ObjectProperty";
const OWL_DATATYPE_PROPERTY = "http://www.w3.org/2002/07/owl#DatatypeProperty";
const SKOS_CONCEPT = "http://www.w3.org/2004/02/skos/core#Concept";
const SKOS_CONCEPT_SCHEME = "http://www.w3.org/2004/02/skos/core#ConceptScheme";
const SKOS_IN_SCHEME = "http://www.w3.org/2004/02/skos/core#inScheme";
const SKOS_HAS_TOP_CONCEPT = "http://www.w3.org/2004/02/skos/core#hasTopConcept";

const uriPrefixes: Array<{ prefix: string; namespace: string }> = [
  { prefix: "eventour", namespace: "http://eventour.unimib.it/" },
  {
    prefix: "rdf",
    namespace: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  },
  { prefix: "rdfs", namespace: "http://www.w3.org/2000/01/rdf-schema#" },
  { prefix: "owl", namespace: "http://www.w3.org/2002/07/owl#" },
  { prefix: "skos", namespace: "http://www.w3.org/2004/02/skos/core#" },
  {
    prefix: "geo",
    namespace: "http://www.opengis.net/ont/geosparql#",
  },
  { prefix: "prov", namespace: "http://www.w3.org/ns/prov#" },
  { prefix: "dct", namespace: "http://purl.org/dc/terms/" },
];

const nodeColors: Record<OntologyNodeKind, string> = {
  class: "#2563eb",
  property: "#16a34a",
  scheme: "#f59e0b",
  concept: "#8b5cf6",
  external: "#64748b",
};

const edgeColors: Record<OntologyEdgeRelation, string> = {
  subClassOf: "#2563eb",
  domain: "#16a34a",
  range: "#f97316",
  inScheme: "#a855f7",
  hasTopConcept: "#ec4899",
};

const relationLegend: Array<{ relation: OntologyEdgeRelation; label: string }> = [
  { relation: "subClassOf", label: "rdfs:subClassOf" },
  { relation: "domain", label: "rdfs:domain" },
  { relation: "range", label: "rdfs:range" },
  { relation: "inScheme", label: "skos:inScheme" },
  { relation: "hasTopConcept", label: "skos:hasTopConcept" },
];

const getNodeKindRank = (kind: OntologyNodeKind): number => {
  switch (kind) {
    case "class":
      return 0;
    case "property":
      return 1;
    case "scheme":
      return 2;
    case "concept":
      return 3;
    case "external":
      return 4;
    default:
      return 5;
  }
};

const unescapeLiteral = (value: string): string =>
  value
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");

const parseNtObject = (token: string): NtObject => {
  const trimmed = token.trim();

  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return { kind: "uri", value: trimmed.slice(1, -1) };
  }

  if (trimmed.startsWith("_:")) {
    return { kind: "blank", value: trimmed };
  }

  if (trimmed.startsWith('"')) {
    const literalMatch = trimmed.match(
      /^"((?:\\.|[^"\\])*)"(?:@([a-zA-Z\-]+)|\^\^<([^>]+)>)?$/,
    );

    if (literalMatch) {
      return {
        kind: "literal",
        value: unescapeLiteral(literalMatch[1]),
        language: literalMatch[2],
      };
    }

    return { kind: "literal", value: trimmed };
  }

  return { kind: "unknown", value: trimmed };
};

const parseNtTriples = (ntText: string): NtTriple[] => {
  const lines = ntText.split(/\r?\n/);
  const triples: NtTriple[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^<([^>]+)>\s+<([^>]+)>\s+(.+)\s+\.\s*$/);
    if (!match) {
      continue;
    }

    triples.push({
      subject: match[1],
      predicate: match[2],
      object: parseNtObject(match[3]),
    });
  }

  return triples;
};

const compactUri = (uri: string): string => {
  for (const { prefix, namespace } of uriPrefixes) {
    if (uri.startsWith(namespace)) {
      return `${prefix}:${uri.slice(namespace.length)}`;
    }
  }
  return uri;
};

const uriTail = (uri: string): string => {
  if (!uri) {
    return uri;
  }

  const hashIndex = uri.lastIndexOf("#");
  if (hashIndex >= 0 && hashIndex < uri.length - 1) {
    return uri.slice(hashIndex + 1);
  }

  const slashIndex = uri.lastIndexOf("/");
  if (slashIndex >= 0 && slashIndex < uri.length - 1) {
    const tail = uri.slice(slashIndex + 1);
    const prevSlash = uri.lastIndexOf("/", slashIndex - 1);
    if (prevSlash >= 0) {
      const parent = uri.slice(prevSlash + 1, slashIndex);
      if (
        parent === "category" ||
        parent === "scheme" ||
        parent === "role" ||
        parent === "curation-label"
      ) {
        return `${parent}/${tail}`;
      }
    }
    return tail;
  }

  return uri;
};

const createNodeLabel = (uri: string, labels: Map<string, string>): string => {
  const fromLabel = labels.get(uri);
  if (fromLabel) {
    return fromLabel;
  }
  return uriTail(uri);
};

const buildOntologyFlow = (ntText: string): OntologyGraphModel => {
  const triples = parseNtTriples(ntText);

  const preferredLabels = new Map<string, string>();
  const fallbackLabels = new Map<string, string>();

  for (const triple of triples) {
    if (triple.predicate !== RDFS_LABEL || triple.object.kind !== "literal") {
      continue;
    }

    const isEnglish = triple.object.language?.toLowerCase().startsWith("en");
    if (isEnglish) {
      preferredLabels.set(triple.subject, triple.object.value);
    } else if (!fallbackLabels.has(triple.subject)) {
      fallbackLabels.set(triple.subject, triple.object.value);
    }
  }

  const labels = new Map<string, string>();
  for (const [uri, label] of fallbackLabels.entries()) {
    labels.set(uri, label);
  }
  for (const [uri, label] of preferredLabels.entries()) {
    labels.set(uri, label);
  }

  const classes = new Set<string>();
  const properties = new Set<string>();
  const schemes = new Set<string>();
  const concepts = new Set<string>();

  for (const triple of triples) {
    if (triple.predicate !== RDF_TYPE || triple.object.kind !== "uri") {
      continue;
    }

    if (triple.object.value === OWL_CLASS) {
      classes.add(triple.subject);
    } else if (
      triple.object.value === RDF_PROPERTY ||
      triple.object.value === OWL_OBJECT_PROPERTY ||
      triple.object.value === OWL_DATATYPE_PROPERTY
    ) {
      properties.add(triple.subject);
    } else if (triple.object.value === SKOS_CONCEPT_SCHEME) {
      schemes.add(triple.subject);
    } else if (triple.object.value === SKOS_CONCEPT) {
      concepts.add(triple.subject);
    }
  }

  const edges: Edge<OntologyEdgeData>[] = [];
  const edgeIds = new Set<string>();
  const connectedUris = new Set<string>();

  const pushEdge = (
    source: string,
    target: string,
    relation: OntologyEdgeRelation,
  ) => {
    const id = `${relation}|${source}|${target}`;
    if (edgeIds.has(id)) {
      return;
    }

    edgeIds.add(id);
    connectedUris.add(source);
    connectedUris.add(target);

    edges.push({
      id,
      source,
      target,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, color: edgeColors[relation] },
      style: {
        stroke: edgeColors[relation],
        strokeWidth: relation === "subClassOf" ? 1.8 : 1.4,
      },
      data: { relation },
    });
  };

  for (const triple of triples) {
    if (triple.object.kind !== "uri") {
      continue;
    }

    if (triple.predicate === RDFS_SUBCLASS_OF) {
      pushEdge(triple.subject, triple.object.value, "subClassOf");
    } else if (triple.predicate === RDFS_DOMAIN) {
      pushEdge(triple.subject, triple.object.value, "domain");
    } else if (triple.predicate === RDFS_RANGE) {
      pushEdge(triple.subject, triple.object.value, "range");
    } else if (triple.predicate === SKOS_IN_SCHEME) {
      pushEdge(triple.subject, triple.object.value, "inScheme");
    } else if (triple.predicate === SKOS_HAS_TOP_CONCEPT) {
      pushEdge(triple.subject, triple.object.value, "hasTopConcept");
    }
  }

  const allNodeUris = new Set<string>([
    ...classes,
    ...properties,
    ...schemes,
    ...concepts,
    ...connectedUris,
  ]);

  const nodeKindMap = new Map<string, OntologyNodeKind>();

  for (const uri of allNodeUris) {
    if (classes.has(uri)) {
      nodeKindMap.set(uri, "class");
      continue;
    }
    if (properties.has(uri)) {
      nodeKindMap.set(uri, "property");
      continue;
    }
    if (schemes.has(uri)) {
      nodeKindMap.set(uri, "scheme");
      continue;
    }
    if (concepts.has(uri)) {
      nodeKindMap.set(uri, "concept");
      continue;
    }
    nodeKindMap.set(uri, "external");
  }

  const sortedUris = Array.from(allNodeUris).sort((a, b) => {
    const kindA = nodeKindMap.get(a) ?? "external";
    const kindB = nodeKindMap.get(b) ?? "external";
    const rankDiff = getNodeKindRank(kindA) - getNodeKindRank(kindB);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return createNodeLabel(a, labels).localeCompare(createNodeLabel(b, labels));
  });

  const groupedByKind: Record<OntologyNodeKind, string[]> = {
    class: [],
    property: [],
    scheme: [],
    concept: [],
    external: [],
  };

  for (const uri of sortedUris) {
    const kind = nodeKindMap.get(uri) ?? "external";
    groupedByKind[kind].push(uri);
  }

  const groupLayout: Record<OntologyNodeKind, { x: number; cols: number }> = {
    class: { x: 0, cols: 3 },
    property: { x: 660, cols: 4 },
    scheme: { x: 1500, cols: 2 },
    concept: { x: 1980, cols: 3 },
    external: { x: 2640, cols: 2 },
  };

  const nodes: Node<OntologyNodeData>[] = [];

  for (const kind of [
    "class",
    "property",
    "scheme",
    "concept",
    "external",
  ] as const) {
    const list = groupedByKind[kind];
    const { x, cols } = groupLayout[kind];

    for (let index = 0; index < list.length; index += 1) {
      const uri = list[index];
      const row = Math.floor(index / cols);
      const col = index % cols;

      nodes.push({
        id: uri,
        position: {
          x: x + col * 210,
          y: 40 + row * 96,
        },
        data: {
          label: createNodeLabel(uri, labels),
          compactUri: compactUri(uri),
          kind,
        },
        draggable: true,
        selectable: true,
        style: {
          border: `1px solid ${nodeColors[kind]}`,
          borderRadius: 10,
          background:
            kind === "external"
              ? "rgba(148, 163, 184, 0.14)"
              : `color-mix(in srgb, ${nodeColors[kind]} 14%, white)`,
          color: "#0f172a",
          width: 190,
          fontSize: 11,
          fontWeight: 600,
          padding: 8,
          boxShadow: "0 3px 12px rgba(15, 23, 42, 0.07)",
        },
      });
    }
  }

  return {
    nodes,
    edges,
    stats: {
      triples: triples.length,
      classes: classes.size,
      properties: properties.size,
      conceptSchemes: schemes.size,
      concepts: concepts.size,
      edges: edges.length,
    },
  };
};

const kindLegend: Array<{ kind: OntologyNodeKind; label: string }> = [
  { kind: "class", label: "OWL Classes" },
  { kind: "property", label: "RDF/OWL Properties" },
  { kind: "scheme", label: "SKOS Concept Schemes" },
  { kind: "concept", label: "SKOS Concepts" },
  { kind: "external", label: "External Linked Nodes" },
];

const OntologyPage = ({ theme }: OntologyPageProps) => {
  const [ontologyText, setOntologyText] = useState("");
  const [ontologyState, setOntologyState] = useState<RequestState>("idle");
  const [requestMessage, setRequestMessage] = useState("");

  const graphModel = useMemo<OntologyGraphModel>(
    () => buildOntologyFlow(ontologyText),
    [ontologyText],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<OntologyNodeData>>(
    [],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<OntologyEdgeData>>(
    [],
  );

  useEffect(() => {
    setNodes(graphModel.nodes);
    setEdges(graphModel.edges);
  }, [graphModel.edges, graphModel.nodes, setEdges, setNodes]);

  useEffect(() => {
    const controller = new AbortController();

    const loadOntology = async () => {
      setOntologyState("loading");
      setRequestMessage("Loading ontology graph...");

      try {
        const response = await fetch("/ontology/eventour_final_ontology.nt", {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Unable to load ontology file (${response.status}).`);
        }

        const text = await response.text();
        if (!text.trim()) {
          throw new Error("The ontology file is empty.");
        }

        setOntologyText(text);
        setOntologyState("success");
        setRequestMessage("Ontology loaded successfully.");
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        setOntologyState("error");
        setRequestMessage(
          error instanceof Error
            ? error.message
            : "Unable to load ontology file.",
        );
      }
    };

    loadOntology().catch(() => {
      if (controller.signal.aborted) {
        return;
      }
      setOntologyState("error");
      setRequestMessage("Unexpected error while loading ontology.");
    });

    return () => controller.abort();
  }, []);

  const cardStyle =
    theme === "dark"
      ? "border-base-200/80 bg-base-100/86 shadow-md shadow-black/25"
      : "border-base-300 bg-base-100/90";

  const graphPanelStyle =
    theme === "dark"
      ? "border-base-200 bg-base-100/80"
      : "border-base-300 bg-white";

  return (
    <section className="flex h-[calc(100vh-4.5rem)] w-full flex-col overflow-hidden px-3 py-3 md:px-4 md:py-4">
      <div className="shrink-0">
        <h1 className="text-3xl font-extrabold">Ontology Explorer</h1>
        <p className="mt-1 text-sm text-base-content/70">
          Visual map of the Eventour knowledge graph ontology from the exported
          N-Triples file.
        </p>
      </div>

      <div className="mt-3 grid shrink-0 gap-2 md:grid-cols-[1.45fr_1fr]">
        <article className={`card rounded-md border ${cardStyle}`}>
          <div className="card-body gap-2 p-2.5">
            <p className="text-xs text-base-content/75">Ontology Stats</p>
            <div className="flex flex-wrap gap-1.5 text-xs">
              <span className="badge badge-outline badge-sm rounded-md">
                Classes: {graphModel.stats.classes}
              </span>
              <span className="badge badge-outline badge-sm rounded-md">
                Properties: {graphModel.stats.properties}
              </span>
              <span className="badge badge-outline badge-sm rounded-md">
                Schemes: {graphModel.stats.conceptSchemes}
              </span>
              <span className="badge badge-outline badge-sm rounded-md">
                Concepts: {graphModel.stats.concepts}
              </span>
              <span className="badge badge-outline badge-sm rounded-md">
                Triples: {graphModel.stats.triples}
              </span>
              <span className="badge badge-outline badge-sm rounded-md">
                Edges: {graphModel.stats.edges}
              </span>
            </div>
          </div>
        </article>

        <article className={`card rounded-md border ${cardStyle}`}>
          <div className="card-body gap-2 p-2.5">
            <p className="text-xs text-base-content/75">Legend</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              {kindLegend.map((item) => (
                <div key={item.kind} className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: nodeColors[item.kind] }}
                  />
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
            <div className="border-t border-base-300/70 pt-2 text-[11px]">
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {relationLegend.map(({ relation, label }) => (
                  <span key={relation} className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block h-[2px] w-4"
                      style={{ backgroundColor: edgeColors[relation] }}
                    />
                    {label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </article>
      </div>

      {ontologyState === "error" && requestMessage ? (
        <div
          className="alert alert-error mt-3 rounded-md"
        >
          <span className="text-sm">{requestMessage}</span>
        </div>
      ) : null}

      <article
        className={`card mt-3 flex-1 min-h-0 overflow-hidden rounded-md border ${graphPanelStyle}`}
      >
        <div className="card-body h-full p-0">
          {ontologyState === "loading" ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-base-content/70">
              <LoaderCircle size={16} className="animate-spin" />
              Loading ontology visualization...
            </div>
          ) : ontologyState === "error" ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-base-content/70">
              Unable to render ontology graph. Check that
              `/public/ontology/eventour_final_ontology.nt` exists and is
              readable.
            </div>
          ) : (
            <div className="h-full w-full">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                minZoom={0.15}
                maxZoom={2}
                attributionPosition="top-right"
              >
                <MiniMap
                  zoomable
                  pannable
                  nodeColor={(node) => {
                    const kind = (node.data as OntologyNodeData | undefined)
                      ?.kind;
                    return kind ? nodeColors[kind] : "#64748b";
                  }}
                  maskColor={theme === "dark" ? "rgba(15,23,42,0.55)" : "rgba(241,245,249,0.65)"}
                />
                <Controls showInteractive={false} />
                <Background gap={20} size={1} />
              </ReactFlow>
            </div>
          )}
        </div>
      </article>
    </section>
  );
};

export default OntologyPage;
