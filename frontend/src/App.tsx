import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Moon,
  Play,
  RotateCcw,
  Sun,
} from 'lucide-react';
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

type Tab = 'home' | 'map' | 'sparql' | 'about';
type Theme = 'light' | 'dark';
type RequestState = 'idle' | 'loading' | 'success' | 'error';

type PoiOption = {
  poi_id: string;
  label: string;
  type: string;
  place: string;
  latitude: number | null;
  longitude: number | null;
};

type ItineraryPoint = {
  poi_id: string;
  label: string;
  type: string;
  place: string;
  latitude: number | null;
  longitude: number | null;
};

type Itinerary = {
  percorso: string;
  nodi: string[];
  tempo_totale_secondi: number;
  tempo_totale_minuti: number;
  stop_intermedi_totali: number;
  punti_totali: number;
  punti: ItineraryPoint[];
};

type CercaItinerariResponse = {
  status: string;
  message?: string;
  paths?: string[];
  llm_response?: string;
  itinerari?: Itinerary[];
};

type SparqlRow = Record<string, string>;

type SparqlQueryResponse = {
  status: string;
  message?: string;
  endpoint?: string;
  result_type?: 'select' | 'ask';
  columns?: string[];
  rows?: SparqlRow[];
  row_count?: number;
  query?: string;
  query_executed?: string;
};

type SparqlTableRow = { __rowId: number } & Record<string, string | number>;

const getApiBaseCandidates = (): string[] => {
  const configured = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
  const runtimeHost =
    typeof window !== 'undefined'
      ? `${window.location.protocol}//${window.location.hostname}:8000`
      : 'http://127.0.0.1:8000';

  return Array.from(
    new Set([configured, runtimeHost, 'http://127.0.0.1:8000', 'http://localhost:8000'].filter(Boolean)),
  ) as string[];
};

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'home', label: 'Home' },
  { id: 'map', label: 'Map' },
  { id: 'sparql', label: 'SPARQL' },
  { id: 'about', label: 'About' },
];

const homeStats = [
  { value: '9,361,049', label: 'KG triples' },
  { value: '906,939', label: 'distinct subjects/entities' },
  { value: '35', label: 'ontology classes' },
  { value: '91', label: 'properties' },
  { value: '21', label: 'official Comune source datasets plus Wikidata' },
  { value: '1,116', label: 'Wikidata primary POIs' },
  { value: '894', label: 'Wikidata secondary POIs' },
  { value: '1,286', label: 'Wikidata context entities' },
];

const defaultSparqlQuery = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

SELECT ?s ?p ?o
WHERE {
  ?s ?p ?o .
}
LIMIT 100`;

const sparqlExamples: Array<{
  label: string;
  description: string;
  query: string;
  tone: 'primary' | 'secondary' | 'accent';
}> = [
  {
    label: 'Milan graph (50)',
    description: 'Inspect triples from the Milan named graph.',
    tone: 'primary',
    query: `SELECT ?s ?p ?o
WHERE {
  GRAPH http://eventour.unimib.it/graph/milan {
    ?s ?p ?o .
  }
}
LIMIT 50`,
  },
  {
    label: 'Count triples in Milan',
    description: 'Compute the total number of triples in graph/milan.',
    tone: 'secondary',
    query: `SELECT (COUNT(*) AS ?total)
WHERE {
  GRAPH <http://eventour.unimib.it/graph/milan> {
    ?s ?p ?o .
  }
}`,
  },
  {
    label: 'Types in Milan',
    description: 'Rank RDF classes by occurrence in graph/milan.',
    tone: 'accent',
    query: `SELECT ?type (COUNT(*) AS ?count)
WHERE {
  GRAPH <http://eventour.unimib.it/graph/milan> {
    ?s a ?type .
  }
}
GROUP BY ?type
ORDER BY DESC(?count)
LIMIT 25`,
  },
];

const placeFilters = [
  { label: 'Museum', value: 'Museo' },
  { label: 'Sculpture', value: 'Scultura' },
  { label: 'Art Gallery', value: "Galleria D'arte" },
  { label: 'Monument', value: 'Monumento' },
  { label: 'Theatre', value: 'Teatro' },
] as const;

type MapFormValues = {
  nodo_partenza: string;
  nodo_arrivo: string;
  filtri: string[];
  max_stop_intermedi: number;
  tempo_massimo_minuti: number;
};

type GraphNode = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
};

const mapFormSchema: z.ZodType<MapFormValues> = z
  .object({
    nodo_partenza: z.string().min(1, 'Please select a start node.'),
    nodo_arrivo: z.string().min(1, 'Please select a destination node.'),
    filtri: z.array(z.string()),
    max_stop_intermedi: z
      .number()
      .int('Only whole numbers are allowed.')
      .min(0, 'Minimum value is 0.')
      .max(10, 'Maximum value is 10.'),
    tempo_massimo_minuti: z
      .number()
      .int('Only whole numbers are allowed.')
      .min(0, 'Minimum value is 0.'),
  })
  .refine((data) => data.nodo_partenza !== data.nodo_arrivo, {
    path: ['nodo_arrivo'],
    message: 'Start and destination must be different.',
  });

const getInitialTheme = (): Theme => {
  if (typeof window === 'undefined') {
    return 'light';
  }

  const savedTheme = window.localStorage.getItem('eventour-theme');
  if (savedTheme === 'light' || savedTheme === 'dark') {
    return savedTheme;
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

function FocusSelectedRoute({ coordinates }: { coordinates: [number, number][] }) {
  const map = useMap();

  useEffect(() => {
    if (coordinates.length === 0) {
      return;
    }

    if (coordinates.length === 1) {
      map.setView(coordinates[0], 15, { animate: true });
      return;
    }

    const bounds = L.latLngBounds(coordinates);
    map.fitBounds(bounds, { padding: [40, 40], animate: true });
  }, [coordinates, map]);

  return null;
}

function FocusSelectedPoint({ point }: { point: [number, number] | null }) {
  const map = useMap();

  useEffect(() => {
    if (!point) {
      return;
    }
    map.setView(point, 16, { animate: true });
  }, [point, map]);

  return null;
}

function AnimatedGraphBackground({ theme }: { theme: Theme }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!context) {
      return;
    }

    let animationFrame = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let nodes: GraphNode[] = [];

    const lineBaseOpacity = theme === 'dark' ? 0.32 : 0.2;
    const nodeBaseOpacity = theme === 'dark' ? 0.97 : 0.83;
    const lineRgb = theme === 'dark' ? '56,189,248' : '37,99,235';
    const nodeRgb = theme === 'dark' ? '125,211,252' : '30,64,175';

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'low';

      const nodeCount = Math.max(54, Math.floor((width * height) / 26000));
      nodes = Array.from({ length: nodeCount }).map(() => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.34,
        vy: (Math.random() - 0.5) * 0.34,
        radius: Math.random() * 4.4 + 2.6,
      }));
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);
      const maxDistance = Math.min(260, Math.max(140, width * 0.18));

      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        node.x += node.vx;
        node.y += node.vy;

        if (node.x <= 0 || node.x >= width) {
          node.vx *= -1;
        }
        if (node.y <= 0 || node.y >= height) {
          node.vy *= -1;
        }

        node.x = Math.max(0, Math.min(width, node.x));
        node.y = Math.max(0, Math.min(height, node.y));
      }

      for (let i = 0; i < nodes.length; i += 1) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j += 1) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance > maxDistance) {
            continue;
          }

          const strength = 1 - distance / maxDistance;
          const alpha = Math.max(0, strength * strength * lineBaseOpacity);
          context.strokeStyle = `rgba(${lineRgb}, ${alpha.toFixed(3)})`;
          context.lineWidth = 1.2;
          context.beginPath();
          context.moveTo(a.x, a.y);
          context.lineTo(b.x, b.y);
          context.stroke();
        }
      }

      for (const node of nodes) {
        context.fillStyle = `rgba(${nodeRgb}, ${nodeBaseOpacity})`;
        context.beginPath();
        context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        context.fill();
      }

      animationFrame = window.requestAnimationFrame(draw);
    };

    resize();
    draw();
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      window.cancelAnimationFrame(animationFrame);
    };
  }, [theme]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-0 h-screen w-screen opacity-80"
      aria-hidden="true"
    />
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  const appBackgroundStyle = useMemo(
    () => ({
      backgroundImage:
        theme === 'dark'
          ? 'linear-gradient(to bottom, var(--color-base-100) 0%, var(--color-base-200) 38%, #020617 100%)'
          : 'linear-gradient(to bottom, var(--color-base-100) 0%, #eef2ff 40%, #e2e8f0 100%)',
    }),
    [theme],
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    window.localStorage.setItem('eventour-theme', theme);
  }, [theme]);

  return (
    <div className="relative h-screen overflow-hidden text-base-content transition-colors" style={appBackgroundStyle}>
      <AnimatedGraphBackground theme={theme} />

      <header className="fixed inset-x-0 top-0 z-20 navbar h-[4.5rem] border-b border-base-300/80 bg-base-100/72 px-1 backdrop-blur-md md:px-2">
        <div className="relative flex w-full items-center">
          <button className="btn btn-ghost text-2xl font-extrabold text-primary" onClick={() => setActiveTab('home')}>
            Eventour
          </button>

          <ul className="menu menu-horizontal absolute left-1/2 min-w-0 -translate-x-1/2 gap-2 overflow-x-auto rounded-md border border-base-300 bg-base-200/92 p-1 md:gap-3">
            {tabs.map((tab) => (
              <li key={tab.id}>
                <button
                  className={`rounded-md px-4 font-semibold md:px-5 ${
                    activeTab === tab.id
                      ? 'bg-primary text-primary-content hover:bg-primary'
                      : 'hover:bg-base-300'
                  }`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              </li>
            ))}
          </ul>

          <button
            className="btn btn-ghost btn-sm btn-square ml-auto rounded-md"
            onClick={() => setTheme((previous) => (previous === 'light' ? 'dark' : 'light'))}
            aria-label={theme === 'light' ? 'Enable dark theme' : 'Enable light theme'}
          >
            {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>
      </header>

      <div className="relative z-10 pt-[4.5rem]">
        {activeTab === 'map' ? (
          <MapPage theme={theme} />
        ) : (
          <main
            className={`mx-auto h-[calc(100vh-4.5rem-16.5rem)] w-full max-w-[1160px] overflow-y-auto px-4 py-8 pb-12 md:px-6 md:py-9 md:pb-12 ${
              activeTab === 'sparql' ? 'hide-scrollbar' : ''
            }`}
          >
            {activeTab === 'home' && <HomePage theme={theme} />}
            {activeTab === 'sparql' && <SparqlPage />}
            {activeTab === 'about' && <AboutPage />}
          </main>
        )}
      </div>

      {activeTab !== 'map' ? <AppFooter /> : null}
    </div>
  );
}

function HomePage({ theme }: { theme: Theme }) {
  const homeCardStyle =
    theme === 'dark'
      ? 'border-base-200/80 bg-base-100/86 shadow-md shadow-black/25'
      : 'border-base-300 bg-base-200/80';

  return (
    <section className="mx-auto w-full max-w-5xl">
      <div className="text-center">
        <h1 className="text-4xl font-extrabold md:text-5xl">Eventour Knowledge Graph</h1>
        <p className="mt-4 text-base-content/70 md:text-xl">
          Snapshot of the current Eventour data graph
        </p>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-4">
        {homeStats.map((stat) => (
          <article key={stat.label} className={`card rounded-md border backdrop-blur-sm ${homeCardStyle}`}>
            <div className="card-body items-center px-5 py-4 text-center">
              <strong className="text-2xl font-extrabold text-primary md:text-3xl">{stat.value}</strong>
              <span className="text-sm text-base-content/80 md:text-base">{stat.label}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function AppFooter() {
  return (
    <footer className="fixed inset-x-0 bottom-0 z-20 h-[16.5rem] border-t border-base-300/70 bg-base-100/76 px-4 py-4 backdrop-blur-md md:px-6">
      <div className="mx-auto grid h-full w-full max-w-[1160px] grid-rows-[auto_1fr_auto] gap-3">
        <section className="rounded-lg border border-base-300/70 bg-base-100/90 px-5 py-4 shadow-sm">
          <div className="grid items-center gap-4 md:grid-cols-[1.2fr_1fr]">
            <div>
              <p className="text-xs uppercase tracking-wide text-base-content/65">Urban Intelligence</p>
              <h3 className="mt-1 text-xl font-bold">Explore Eventour Graph Insights</h3>
              <p className="mt-1 text-sm text-base-content/75">
                Discover connected city entities for itineraries, cultural discovery, and semantic exploration.
              </p>
            </div>
            <div className="hidden md:flex justify-center">
              <div className="relative h-20 w-56">
                <div className="absolute left-1/2 top-1/2 h-[4.5rem] w-[4.5rem] -translate-x-1/2 -translate-y-1/2 rounded-full border border-base-300/70" />
                <div className="absolute left-1/2 top-1/2 h-28 w-28 -translate-x-1/2 -translate-y-1/2 rounded-full border border-base-300/55" />
                <div className="absolute left-1/2 top-1/2 h-36 w-36 -translate-x-1/2 -translate-y-1/2 rounded-full border border-base-300/40" />
                <div className="absolute left-[14%] top-[22%] h-2.5 w-2.5 rounded-full bg-primary" />
                <div className="absolute left-[75%] top-[16%] h-2.5 w-2.5 rounded-full bg-secondary" />
                <div className="absolute left-[66%] top-[66%] h-2.5 w-2.5 rounded-full bg-accent" />
                <div className="absolute left-[30%] top-[70%] h-2.5 w-2.5 rounded-full bg-info" />
              </div>
            </div>
          </div>
        </section>

        <div className="grid grid-cols-2 gap-4 text-xs md:grid-cols-4">
          <div>
            <p className="font-semibold text-primary">Eventour</p>
            <p className="mt-1 text-base-content/70">Semantic urban graph platform for Milan.</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="badge badge-outline badge-sm rounded-md">Coverage</span>
              <span className="badge badge-info badge-sm rounded-md">Milan</span>
            </div>
          </div>
          <div>
            <p className="font-semibold">Platform</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="badge badge-outline badge-sm rounded-md">Map</span>
              <span className="badge badge-primary badge-sm rounded-md">Explorer</span>
              <span className="badge badge-outline badge-sm rounded-md">SPARQL</span>
              <span className="badge badge-secondary badge-sm rounded-md">Workspace</span>
            </div>
          </div>
          <div>
            <p className="font-semibold">Resources</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="badge badge-outline badge-sm rounded-md">Graph</span>
              <span className="badge badge-accent badge-sm rounded-md">Knowledge Base</span>
              <span className="badge badge-outline badge-sm rounded-md">Sources</span>
              <span className="badge badge-success badge-sm rounded-md">Open Data</span>
            </div>
          </div>
          <div>
            <p className="font-semibold">Contact</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="badge badge-outline badge-sm rounded-md">Team</span>
              <span className="badge badge-warning badge-sm rounded-md">Research & Product</span>
              <span className="badge badge-outline badge-sm rounded-md">Location</span>
              <span className="badge badge-neutral badge-sm rounded-md">Milan, Italy</span>
            </div>
          </div>
        </div>

        <div className="border-t border-base-300/60 pt-2 text-xs text-base-content/65">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>© 2026 Eventour. All rights reserved.</p>
            <p>Eventour semantic urban knowledge graph interface.</p>
          </div>
        </div>
      </div>
    </footer>
  );
}

function MapPage({ theme }: { theme: Theme }) {
  const [poiOptions, setPoiOptions] = useState<PoiOption[]>([]);
  const [poisState, setPoisState] = useState<RequestState>('idle');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const [requestMessage, setRequestMessage] = useState('');
  const [itineraries, setItineraries] = useState<Itinerary[]>([]);
  const [selectedItineraryPath, setSelectedItineraryPath] = useState<string | null>(null);
  const [selectedRoutePoint, setSelectedRoutePoint] = useState<{ route: string; index: number } | null>(null);
  const markerRefs = useRef<Record<string, L.Marker | null>>({});
  const milanCenter: [number, number] = [45.4642, 9.19];
  const sidebarGradient =
    theme === 'dark'
      ? 'bg-[linear-gradient(to_bottom,rgba(17,24,39,0.95),rgba(15,23,42,0.98))]'
      : 'bg-[linear-gradient(to_bottom,rgba(255,255,255,0.94),rgba(248,250,252,0.98))]';

  const selectedMarkerIcon = useMemo(
    () =>
      L.divIcon({
        className: '',
        html: '<div style="width:14px;height:14px;border-radius:9999px;background:#94a3b8;border:2px solid var(--color-base-100);box-shadow:0 0 0 2px rgba(148,163,184,0.25)"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
    [],
  );

  const startMarkerIcon = useMemo(
    () =>
      L.divIcon({
        className: '',
        html: '<div style="width:16px;height:16px;border-radius:9999px;background:#16a34a;border:2px solid var(--color-base-100);box-shadow:0 0 0 3px rgba(22,163,74,0.28)"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
    [],
  );

  const endMarkerIcon = useMemo(
    () =>
      L.divIcon({
        className: '',
        html: '<div style="width:16px;height:16px;border-radius:9999px;background:#2563eb;border:2px solid var(--color-base-100);box-shadow:0 0 0 3px rgba(37,99,235,0.28)"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
    [],
  );

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<MapFormValues>({
    resolver: zodResolver(mapFormSchema as any) as any,
    defaultValues: {
      nodo_partenza: '',
      nodo_arrivo: '',
      filtri: [],
      max_stop_intermedi: 0,
      tempo_massimo_minuti: 60,
    },
  });

  const mapTile = useMemo(
    () =>
      theme === 'dark'
        ? {
            url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
          }
        : {
            url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          },
    [theme],
  );

  const selectedItinerary = useMemo(
    () => itineraries.find((itinerary) => itinerary.percorso === selectedItineraryPath) ?? null,
    [itineraries, selectedItineraryPath],
  );

  const selectedRouteCoordinates = useMemo<[number, number][]>(
    () =>
      selectedItinerary
        ? selectedItinerary.punti
            .filter(
              (point): point is ItineraryPoint & { latitude: number; longitude: number } =>
                typeof point.latitude === 'number' && typeof point.longitude === 'number',
            )
            .map((point) => [point.latitude, point.longitude])
        : [],
    [selectedItinerary],
  );

  const selectedPoint = useMemo(() => {
    if (!selectedRoutePoint) {
      return null;
    }
    const route = itineraries.find((itinerary) => itinerary.percorso === selectedRoutePoint.route);
    if (!route) {
      return null;
    }
    return route.punti[selectedRoutePoint.index] ?? null;
  }, [selectedRoutePoint, itineraries]);

  const selectedPointCoordinates = useMemo<[number, number] | null>(() => {
    if (
      selectedPoint
      && typeof selectedPoint.latitude === 'number'
      && typeof selectedPoint.longitude === 'number'
    ) {
      return [selectedPoint.latitude, selectedPoint.longitude];
    }
    return null;
  }, [selectedPoint]);

  useEffect(() => {
    if (!selectedRoutePoint) {
      return;
    }
    const markerKey = `${selectedRoutePoint.route}__${selectedRoutePoint.index}`;
    const marker = markerRefs.current[markerKey];
    if (marker) {
      marker.openPopup();
    }
  }, [selectedRoutePoint, itineraries]);

  useEffect(() => {
    const controller = new AbortController();

    const fetchPois = async () => {
      setPoisState('loading');
      const candidates = getApiBaseCandidates();
      let lastError = 'No backend reachable.';

      try {
        for (const candidate of candidates) {
          try {
            const response = await fetch(`${candidate}/pois`, { signal: controller.signal });
            if (!response.ok) {
              lastError = `Backend ${candidate} responded with status ${response.status}.`;
              continue;
            }
            const data = await response.json();
            const options = Array.isArray(data.items) ? (data.items as PoiOption[]) : [];
            setPoiOptions(options);
            if (!getValues('nodo_partenza')) {
              setValue('nodo_partenza', options[0]?.poi_id || '');
            }
            if (!getValues('nodo_arrivo')) {
              setValue('nodo_arrivo', options[1]?.poi_id || options[0]?.poi_id || '');
            }
            setApiBaseUrl(candidate);
            setPoisState('success');
            return;
          } catch {
            lastError = `Unable to reach ${candidate}.`;
          }
        }

        throw new Error(lastError);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setPoisState('error');
        setRequestState('error');
        setRequestMessage(
          error instanceof Error ? error.message : 'Unable to load the POI list from the backend.',
        );
      }
    };

    fetchPois();
    return () => controller.abort();
  }, [getValues, setValue]);

  const onSubmit = async (values: MapFormValues) => {
    if (!values.nodo_partenza || !values.nodo_arrivo) {
      setRequestState('error');
      setRequestMessage('Select valid start and destination nodes.');
      return;
    }

    setRequestState('loading');
    setRequestMessage('');
    setItineraries([]);
    setSelectedItineraryPath(null);
    setSelectedRoutePoint(null);
    const candidates = apiBaseUrl
      ? [apiBaseUrl, ...getApiBaseCandidates().filter((candidate) => candidate !== apiBaseUrl)]
      : getApiBaseCandidates();

    try {
      let result: CercaItinerariResponse | null = null;
      let lastError = 'No backend reachable.';

      for (const candidate of candidates) {
        try {
          const response = await fetch(`${candidate}/cerca-itinerari`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              nodo_partenza: values.nodo_partenza,
              nodo_arrivo: values.nodo_arrivo,
              filtri: values.filtri,
              max_stop_intermedi: values.max_stop_intermedi,
              tempo_massimo_minuti: values.tempo_massimo_minuti,
            }),
          });

          if (!response.ok) {
            const body = await response.text();
            try {
              const parsed = JSON.parse(body) as { detail?: unknown; message?: unknown };
              const detail =
                typeof parsed.detail === 'string'
                  ? parsed.detail
                  : typeof parsed.message === 'string'
                    ? parsed.message
                    : body;
              lastError = detail || `Backend ${candidate} responded with status ${response.status}.`;
            } catch {
              lastError = body || `Backend ${candidate} responded with status ${response.status}.`;
            }
            continue;
          }

          result = (await response.json()) as CercaItinerariResponse;
          setApiBaseUrl(candidate);
          break;
        } catch {
          lastError = `Unable to reach ${candidate}.`;
        }
      }

      if (!result) {
        throw new Error(lastError);
      }

      const extractedItineraries = Array.isArray(result.itinerari) ? result.itinerari : [];
      setItineraries(extractedItineraries);

      if (extractedItineraries.length > 0) {
        setRequestState('success');
        setRequestMessage(
          `Found ${extractedItineraries.length} routes. Select one to display it on the map.`,
        );
      } else {
        setRequestState('error');
        setRequestMessage(
          result.llm_response || 'No routes found for the selected constraints.',
        );
      }
    } catch (error) {
      setRequestState('error');
      setItineraries([]);
      setSelectedItineraryPath(null);
      setSelectedRoutePoint(null);
      const fallback = 'Unable to reach the backend. Make sure it is running on port 8000.';
      setRequestMessage(error instanceof Error ? error.message : fallback);
    }
  };

  return (
    <section className="grid h-[calc(100vh-4.5rem)] grid-cols-1 overflow-hidden md:grid-cols-[340px_1fr]">
      <aside className={`overflow-y-auto border-r border-base-300/80 p-4 backdrop-blur md:p-5 ${sidebarGradient}`}>
        <h2 className="text-xl font-semibold">Route Planner</h2>
        <p className="mt-1 text-sm text-base-content/70">
          Choose start/destination nodes, points of interest filters, and route limits.
        </p>

        <form className="card mt-4 rounded-md border border-base-300/80 bg-base-100/72 shadow-sm" onSubmit={handleSubmit(onSubmit)}>
          <div className="card-body grid gap-4 p-4">
          <label className="form-control w-full">
            <div className="label pb-1">
              <span className="label-text">Start Node</span>
            </div>
            <select
              className="select select-bordered w-full rounded-md"
              disabled={poisState === 'loading' || poiOptions.length === 0}
              {...register('nodo_partenza')}
            >
              {poisState === 'loading' ? <option>Loading POIs...</option> : null}
              {poisState === 'error' ? <option>POI loading error</option> : null}
              {poiOptions.map((poi) => (
                <option key={`start-${poi.poi_id}`} value={poi.poi_id}>
                  {poi.poi_id} - {poi.label} ({poi.type})
                </option>
              ))}
            </select>
            {errors.nodo_partenza ? (
              <span className="mt-1 text-xs text-error">{errors.nodo_partenza.message}</span>
            ) : null}
          </label>

          <label className="form-control w-full">
            <div className="label pb-1">
              <span className="label-text">Destination Node</span>
            </div>
            <select
              className="select select-bordered w-full rounded-md"
              disabled={poisState === 'loading' || poiOptions.length === 0}
              {...register('nodo_arrivo')}
            >
              {poisState === 'loading' ? <option>Loading POIs...</option> : null}
              {poisState === 'error' ? <option>POI loading error</option> : null}
              {poiOptions.map((poi) => (
                <option key={`end-${poi.poi_id}`} value={poi.poi_id}>
                  {poi.poi_id} - {poi.label} ({poi.type})
                </option>
              ))}
            </select>
            {errors.nodo_arrivo ? (
              <span className="mt-1 text-xs text-error">{errors.nodo_arrivo.message}</span>
            ) : null}
          </label>

          <fieldset className="rounded-md border border-base-300 p-3">
            <legend className="px-2 text-sm font-semibold">POI Filters</legend>
            <div className="grid gap-1">
              {placeFilters.map((filter) => (
                <label key={filter.value} className="label cursor-pointer justify-start gap-3 py-1">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm rounded-sm"
                    value={filter.value}
                    {...register('filtri')}
                  />
                  <span className="label-text">{filter.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="form-control w-full">
            <div className="label pb-1">
              <span className="label-text">Maximum Intermediate Stops (0-10)</span>
            </div>
            <input
              type="number"
              min={0}
              max={10}
              step={1}
              className="input input-bordered w-full rounded-md"
              {...register('max_stop_intermedi', {
                valueAsNumber: true,
              })}
            />
            {errors.max_stop_intermedi ? (
              <span className="mt-1 text-xs text-error">{errors.max_stop_intermedi.message}</span>
            ) : null}
          </label>

          <label className="form-control w-full">
            <div className="label pb-1">
              <span className="label-text">Maximum Available Time (minutes)</span>
            </div>
            <input
              type="number"
              min={0}
              step={1}
              className="input input-bordered w-full rounded-md"
              {...register('tempo_massimo_minuti', {
                valueAsNumber: true,
              })}
            />
            {errors.tempo_massimo_minuti ? (
              <span className="mt-1 text-xs text-error">{errors.tempo_massimo_minuti.message}</span>
            ) : null}
          </label>

          <button
            className="btn btn-primary rounded-md"
            type="submit"
            disabled={requestState === 'loading' || poisState === 'loading' || poiOptions.length === 0}
          >
            {requestState === 'loading' ? (
              <>
                <LoaderCircle size={14} className="animate-spin" />
                Calculating
              </>
            ) : (
              'Calculate Routes'
            )}
          </button>

          {requestMessage && requestState !== 'loading' ? (
            <div
              className={`alert rounded-md ${
                requestState === 'success'
                  ? 'alert-success'
                  : requestState === 'error'
                    ? 'alert-error'
                    : 'alert-info'
              }`}
            >
              <span className="text-sm whitespace-pre-wrap break-words">{requestMessage}</span>
            </div>
          ) : null}
          </div>
        </form>

        {itineraries.length > 0 ? (
          <section className="card mt-4 rounded-md border border-primary/30 bg-base-100/72 shadow-sm">
            <div className="card-body p-4">
              <h3 className="text-sm font-semibold uppercase text-primary/90">
                Available Routes
              </h3>
              <div className="grid gap-2">
              {itineraries.map((itinerary, itineraryIndex) => {
                const isSelected = selectedItineraryPath === itinerary.percorso;
                return (
                  <div
                    key={`${itinerary.percorso}-${itineraryIndex}`}
                    className={`collapse collapse-arrow rounded-md border ${
                      isSelected ? 'border-primary bg-base-100' : 'border-base-300 bg-base-200'
                    }`}
                  >
                    <input
                      type="radio"
                      name="itinerary-accordion"
                      checked={isSelected}
                      onChange={() => {
                        setSelectedItineraryPath(itinerary.percorso);
                        setSelectedRoutePoint(null);
                      }}
                    />
                    <div className="collapse-title pr-10">
                      <div className="flex items-center justify-between gap-2">
                        <h4 className="text-sm font-semibold">Route {itineraryIndex + 1}</h4>
                        <span className="badge badge-primary rounded-md">
                          {itinerary.tempo_totale_minuti} min
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        <span className="badge badge-outline rounded-md">
                          Intermediate stops: {itinerary.stop_intermedi_totali}
                        </span>
                        <span className="badge badge-outline rounded-md">
                          Total points: {itinerary.punti_totali}
                        </span>
                      </div>
                    </div>
                    <div className="collapse-content pt-1">
                      <div className="relative space-y-2">
                        {itinerary.punti.map((point, pointIndex) => {
                          const isLast = pointIndex === itinerary.punti.length - 1;
                          const isActivePoint =
                            selectedRoutePoint?.route === itinerary.percorso
                            && selectedRoutePoint.index === pointIndex;
                          return (
                            <button
                              key={`${itinerary.percorso}-${point.poi_id}-${pointIndex}`}
                              type="button"
                              className="relative block w-full pl-8 text-left"
                              onClick={() => {
                                setSelectedItineraryPath(itinerary.percorso);
                                setSelectedRoutePoint({ route: itinerary.percorso, index: pointIndex });
                              }}
                            >
                              {!isLast ? (
                                <span className="absolute left-[9px] top-6 h-[calc(100%-0.2rem)] w-px bg-primary/45" />
                              ) : null}
                              <span className={`absolute left-0 top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                                isActivePoint ? 'bg-secondary text-secondary-content' : 'bg-primary text-primary-content'
                              }`}>
                                {pointIndex + 1}
                              </span>
                              <div className={`rounded-md border bg-base-100 p-2 text-xs transition hover:border-primary/60 hover:bg-base-200/40 ${
                                isActivePoint ? 'border-primary shadow-sm' : 'border-base-300'
                              }`}>
                                <p className="font-semibold">{point.label}</p>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  <span className="badge badge-sm rounded-md border-base-300 bg-base-100 text-base-content/75">Node</span>
                                  <span className="badge badge-primary badge-sm rounded-md">{point.poi_id}</span>
                                  <span className="badge badge-sm rounded-md border-base-300 bg-base-100 text-base-content/75">Type</span>
                                  <span className="badge badge-secondary badge-sm rounded-md">{point.type || '-'}</span>
                                  <span className="badge badge-sm rounded-md border-base-300 bg-base-100 text-base-content/75">Place</span>
                                  <span className="badge badge-accent badge-sm rounded-md">{point.place || '-'}</span>
                                  <span className="badge badge-sm rounded-md border-base-300 bg-base-100 text-base-content/75">Lat</span>
                                  <span className="badge badge-info badge-sm rounded-md">{point.latitude ?? '-'}</span>
                                  <span className="badge badge-sm rounded-md border-base-300 bg-base-100 text-base-content/75">Lng</span>
                                  <span className="badge badge-success badge-sm rounded-md">{point.longitude ?? '-'}</span>
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
          </section>
        ) : null}
      </aside>

      <section className="h-full">
        <MapContainer
          key={theme}
          center={milanCenter}
          zoom={13}
          scrollWheelZoom
          className={`h-full w-full ${theme === 'dark' ? 'map-dark-theme' : ''}`}
        >
          <TileLayer attribution={mapTile.attribution} url={mapTile.url} />
          {selectedRouteCoordinates.length > 1 ? (
            <Polyline
              positions={selectedRouteCoordinates}
              pathOptions={{ color: 'var(--color-primary)', weight: 5, opacity: 0.95 }}
            />
          ) : null}
          <FocusSelectedRoute coordinates={selectedRouteCoordinates} />
          <FocusSelectedPoint point={selectedPointCoordinates} />
          {(selectedItinerary?.punti || [])
            .map((point, index, points) => {
              if (typeof point.latitude !== 'number' || typeof point.longitude !== 'number') {
                return null;
              }
              const routeKey = selectedItinerary?.percorso || '';
              const pointMarkerKey = `${routeKey}__${index}`;
              return (
            <Marker
              key={`${point.poi_id}-${index}`}
              position={[point.latitude, point.longitude]}
              ref={(instance) => {
                markerRefs.current[pointMarkerKey] = instance;
              }}
              eventHandlers={{
                click: () => {
                  if (selectedItinerary) {
                    setSelectedRoutePoint({ route: selectedItinerary.percorso, index });
                  }
                },
              }}
              icon={
                index === 0
                  ? startMarkerIcon
                  : index === points.length - 1
                    ? endMarkerIcon
                    : selectedMarkerIcon
              }
            >
              <Popup>
                <div className="w-[200px] rounded-md border border-base-300 bg-base-100 p-2 text-xs">
                  <p className="font-semibold text-sm">{point.label}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className="badge badge-sm rounded-md border-base-300 bg-base-100 text-base-content/75">Node</span>
                    <span className="badge badge-primary badge-sm rounded-md">{point.poi_id}</span>
                    <span className="badge badge-sm rounded-md border-base-300 bg-base-100 text-base-content/75">Type</span>
                    <span className="badge badge-secondary badge-sm rounded-md">{point.type || '-'}</span>
                    <span className="badge badge-sm rounded-md border-base-300 bg-base-100 text-base-content/75">Place</span>
                    <span className="badge badge-accent badge-sm rounded-md">{point.place || '-'}</span>
                    <span className="badge badge-sm rounded-md border-base-300 bg-base-100 text-base-content/75">Lat</span>
                    <span className="badge badge-info badge-sm rounded-md">{point.latitude}</span>
                    <span className="badge badge-sm rounded-md border-base-300 bg-base-100 text-base-content/75">Lng</span>
                    <span className="badge badge-success badge-sm rounded-md">{point.longitude}</span>
                  </div>
                </div>
              </Popup>
            </Marker>
              );
            })}
        </MapContainer>
      </section>
    </section>
  );
}

function SparqlPage() {
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [query, setQuery] = useState(defaultSparqlQuery);
  const [activeExample, setActiveExample] = useState<string | null>(null);
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const [requestMessage, setRequestMessage] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<SparqlRow[]>([]);
  const [endpointUsed, setEndpointUsed] = useState(
    'https://eventour-graphdb.whattadata.it/repositories/eventour',
  );
  const [queryExecuted, setQueryExecuted] = useState('');
  const [resultType, setResultType] = useState<'select' | 'ask'>('select');
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });

  const tableData = useMemo<SparqlTableRow[]>(
    () => rows.map((row, index) => ({ __rowId: index + 1, ...row })),
    [rows],
  );

  const tableColumns = useMemo<ColumnDef<SparqlTableRow>[]>(
    () => [
      {
        accessorKey: '__rowId',
        header: '#',
        cell: (info: any) => Number(info.getValue()),
      },
      ...columns.map((columnName) => ({
        id: columnName,
        accessorFn: (row: SparqlTableRow) => row[columnName] ?? '',
        header: columnName,
        cell: (info: any) => {
          const value = info.getValue();
          return (
            <span className="block max-w-[420px] overflow-hidden text-ellipsis whitespace-nowrap" title={String(value ?? '')}>
              {String(value ?? '')}
            </span>
          );
        },
      })),
    ],
    [columns],
  );

  const table = useReactTable({
    data: tableData,
    columns: tableColumns,
    state: { pagination },
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const runQuery = async () => {
    const cleaned = query.trim();
    if (!cleaned) {
      setRequestState('error');
      setRequestMessage('Enter a valid SPARQL query.');
      setRows([]);
      setColumns([]);
      return;
    }

    setRequestState('loading');
    setRequestMessage('Running query...');
    setRows([]);
    setColumns([]);
    setQueryExecuted('');
    setPagination((previous) => ({ ...previous, pageIndex: 0 }));

    const candidates = apiBaseUrl
      ? [apiBaseUrl, ...getApiBaseCandidates().filter((candidate) => candidate !== apiBaseUrl)]
      : getApiBaseCandidates();

    try {
      let result: SparqlQueryResponse | null = null;
      let lastError = 'No backend reachable.';

      for (const candidate of candidates) {
        try {
          const response = await fetch(`${candidate}/sparql/query`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query: cleaned }),
          });

          if (!response.ok) {
            const body = await response.text();
            try {
              const parsed = JSON.parse(body) as { detail?: unknown; message?: unknown };
              const detail =
                typeof parsed.detail === 'string'
                  ? parsed.detail
                  : typeof parsed.message === 'string'
                    ? parsed.message
                    : body;
              lastError = detail || `Backend ${candidate} responded with status ${response.status}.`;
            } catch {
              lastError = body || `Backend ${candidate} responded with status ${response.status}.`;
            }
            continue;
          }

          result = (await response.json()) as SparqlQueryResponse;
          setApiBaseUrl(candidate);
          break;
        } catch {
          lastError = `Unable to reach ${candidate}.`;
        }
      }

      if (!result) {
        throw new Error(lastError);
      }

      const nextColumns = Array.isArray(result.columns) ? result.columns : [];
      const nextRows = Array.isArray(result.rows) ? result.rows : [];
      setColumns(nextColumns);
      setRows(nextRows);
      setResultType(result.result_type === 'ask' ? 'ask' : 'select');
      setEndpointUsed(result.endpoint || endpointUsed);
      setQueryExecuted(result.query_executed || cleaned);
      setRequestState('success');
      setRequestMessage(result.message || `Query completed. ${nextRows.length} rows.`);
    } catch (error) {
      setRequestState('error');
      setRows([]);
      setColumns([]);
      setQueryExecuted('');
      setRequestMessage(
        error instanceof Error
          ? error.message
          : 'Error while executing the SPARQL query.',
      );
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runQuery();
  };

  const handleReset = () => {
    setQuery(defaultSparqlQuery);
    setActiveExample(null);
    setRows([]);
    setColumns([]);
    setQueryExecuted('');
    setRequestState('idle');
    setRequestMessage('');
    setPagination({ pageIndex: 0, pageSize: 25 });
  };

  return (
    <section className="mx-auto w-full max-w-[1160px]">
      <div>
        <h1 className="text-4xl font-extrabold">SPARQL Query Interface</h1>
        <p className="mt-3 text-base-content/70">
          Run SPARQL queries on GraphDB and inspect paginated results.
        </p>
      </div>

      <article className="card mt-6 rounded-md border border-base-300 bg-base-100/95 shadow-sm">
        <div className="card-body gap-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <p className="text-xs text-base-content/70">
              Endpoint: <span className="font-mono">{endpointUsed}</span>
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-ghost btn-sm rounded-md"
                onClick={handleReset}
              >
                <RotateCcw size={16} />
                Reset
              </button>
              <button
                type="submit"
                form="sparql-form"
                className="btn btn-primary btn-sm rounded-md"
                disabled={requestState === 'loading'}
              >
                {requestState === 'loading' ? (
                  <>
                    <LoaderCircle size={16} className="animate-spin" />
                    Running...
                  </>
                ) : (
                  <>
                    <Play size={16} />
                    Run
                  </>
                )}
              </button>
            </div>
          </div>
          <form id="sparql-form" onSubmit={handleSubmit}>
            <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
              {sparqlExamples.map((example) => {
                const toneClasses =
                  example.tone === 'primary'
                    ? 'border-primary/45 from-primary/12 to-primary/5'
                    : example.tone === 'secondary'
                      ? 'border-secondary/45 from-secondary/12 to-secondary/5'
                      : 'border-accent/45 from-accent/12 to-accent/5';
                const isActive = activeExample === example.label;

                return (
                  <button
                    key={example.label}
                    type="button"
                    className={`card rounded-md border bg-gradient-to-br text-left transition ${
                      isActive
                        ? `${toneClasses} ring-2 ring-primary/40`
                        : `${toneClasses} hover:border-primary/55 hover:shadow`
                    }`}
                    onClick={() => {
                      setQuery(example.query);
                      setActiveExample(example.label);
                    }}
                  >
                    <div className="card-body gap-2 px-3 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-bold">{example.label}</h3>
                        <span className="badge badge-outline badge-xs rounded-md">Example</span>
                      </div>
                      <p className="text-xs text-base-content/70">{example.description}</p>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="rounded-md border border-primary/35 bg-[linear-gradient(135deg,rgba(59,130,246,0.14),rgba(99,102,241,0.06)_45%,rgba(16,185,129,0.08))] shadow-md shadow-primary/10">
              <div className="flex items-center justify-between border-b border-base-300/70 bg-base-100/75 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-error" />
                  <span className="h-2.5 w-2.5 rounded-full bg-warning" />
                  <span className="h-2.5 w-2.5 rounded-full bg-success" />
                </div>
                <span className="text-xs font-semibold uppercase tracking-wide text-base-content/70">
                  Query editor
                </span>
              </div>
              <textarea
                className="textarea textarea-ghost min-h-[320px] w-full rounded-md border-0 bg-transparent font-mono text-sm leading-6 focus:outline-none"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveExample(null);
                }}
                spellCheck={false}
                placeholder="Write your SPARQL query here..."
              />
            </div>
          </form>
        </div>
      </article>

      {requestMessage ? (
        <div
          className={`alert mt-4 rounded-md ${
            requestState === 'success'
              ? 'alert-success'
              : requestState === 'error'
                ? 'alert-error'
                : 'alert-info'
          }`}
        >
          <span className="text-sm break-words">{requestMessage}</span>
        </div>
      ) : null}

      {queryExecuted && queryExecuted !== query.trim() ? (
        <div className="alert alert-info mt-3 rounded-md">
          <span className="text-xs break-words">
            Query normalized automatically for GraphDB: GRAPH http://... becomes GRAPH {'<'}http://...{'>'}
          </span>
        </div>
      ) : null}

      <article className="card mt-4 rounded-md border border-base-300 bg-base-100/95 shadow-sm">
        <div className="card-body gap-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <span className="badge badge-outline rounded-md uppercase">
                {resultType}
              </span>
              <span className="badge badge-neutral rounded-md">{rows.length} rows</span>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <span>Page size</span>
              <select
                className="select select-bordered select-sm rounded-md"
                value={pagination.pageSize}
                onChange={(event) =>
                  setPagination({
                    pageIndex: 0,
                    pageSize: Number(event.target.value),
                  })
                }
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>
          </div>

          <div className="overflow-x-auto border border-base-300">
            <table className="table table-zebra table-pin-rows">
              <thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th key={header.id}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.length === 0 ? (
                  <tr>
                    <td colSpan={Math.max(1, tableColumns.length)} className="py-8 text-center text-base-content/70">
                      No results to display.
                    </td>
                  </tr>
                ) : (
                  table.getRowModel().rows.map((row) => (
                    <tr key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <p className="text-sm text-base-content/70">
              Page {table.getState().pagination.pageIndex + 1} of {Math.max(1, table.getPageCount())}
            </p>
            <div className="join">
              <button
                className="btn btn-sm join-item rounded-md"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
                type="button"
              >
                <ChevronLeft size={16} />
                Prev
              </button>
              <button
                className="btn btn-sm join-item rounded-md"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
                type="button"
              >
                Next
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </div>
      </article>
    </section>
  );
}

function AboutPage() {
  return (
    <section className="mx-auto h-full w-full max-w-[1160px]">
      <div>
        <h1 className="text-4xl font-extrabold">About Eventour</h1>
      </div>

      <article className="card mt-6 rounded-md border border-base-300 bg-base-100/92 shadow-sm">
        <div className="card-body">
          <h2 className="card-title">Semantic Urban Graph</h2>
          <p className="text-base-content/80">
            Eventour is a semantic urban knowledge graph for Milan that connects cultural places, public services, transport, green assets, and neighborhood context into one integrated city resource. It helps applications support smarter event discovery, cultural itineraries, and context-aware urban exploration.
          </p>
        </div>
      </article>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
        <article className="card rounded-md border border-base-300 bg-base-100/90 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">Purpose</h2>
            <p>
              The interface is designed for fast exploration of indications, contraindications,
              interactions, and adverse reactions represented as RDF triples.
            </p>
          </div>
        </article>
        <article className="card rounded-md border border-base-300 bg-base-100/90 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">Data model</h2>
            <p>
              Common biomedical vocabularies and Eventour namespaces keep drug products,
              ingredients, side effects, and SPL documents linked consistently.
            </p>
          </div>
        </article>
        <article className="card rounded-md border border-base-300 bg-base-100/90 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">Map view</h2>
            <p>
              Spatial context highlights repositories, curators, and partner nodes connected to
              the knowledge graph.
            </p>
          </div>
        </article>
      </div>
    </section>
  );
}

export default App;
