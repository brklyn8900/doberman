import { useState, useEffect, useRef } from "react";
import { SSEState } from "../hooks/useSSE";
import { getApiBaseUrl } from "../api";

interface DebugPanelProps {
  port: number | null;
  sse: SSEState;
}

interface LogEntry {
  time: string;
  type: string;
  data: string;
}

export default function DebugPanel({ port, sse }: DebugPanelProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [apiResponse, setApiResponse] = useState<string>("");
  const [apiEndpoint, setApiEndpoint] = useState("/api/status");
  const [sseRaw, setSseRaw] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  // Track SSE events in the log
  useEffect(() => {
    if (!sse.connected) return;
    const now = new Date().toLocaleTimeString();

    // Log latest pings
    sse.lastPings.forEach((ping, target) => {
      setLogs((prev) => {
        const entry: LogEntry = {
          time: now,
          type: "ping_result",
          data: `${target}: ${ping.success ? `${ping.latency_ms?.toFixed(1)}ms` : "FAIL"}`,
        };
        return [...prev.slice(-200), entry];
      });
    });
  }, [sse.lastPings, sse.connected]);

  // Track connection state changes
  useEffect(() => {
    const now = new Date().toLocaleTimeString();
    setLogs((prev) => [
      ...prev.slice(-200),
      {
        time: now,
        type: "connection",
        data: sse.connected ? "SSE connected" : "SSE disconnected",
      },
    ]);
  }, [sse.connected]);

  // Raw SSE listener for debugging
  useEffect(() => {
    if (!port) return;
    const es = new EventSource(`${getApiBaseUrl(port)}/api/events`);

    const handler = (e: MessageEvent) => {
      const now = new Date().toLocaleTimeString();
      setSseRaw((prev) => [...prev.slice(-50), `[${now}] ${e.type}: ${e.data.slice(0, 200)}`]);
    };

    // Listen to all known event types
    for (const t of ["ping_result", "outage_start", "outage_end", "stats_update", "status_change", "speed_test_start", "speed_test_result"]) {
      es.addEventListener(t, handler as EventListener);
    }
    // Also catch unnamed events
    es.onmessage = (e) => {
      const now = new Date().toLocaleTimeString();
      setSseRaw((prev) => [...prev.slice(-50), `[${now}] message: ${e.data.slice(0, 200)}`]);
    };
    es.onerror = () => {
      const now = new Date().toLocaleTimeString();
      setSseRaw((prev) => [...prev.slice(-50), `[${now}] ERROR: SSE connection error`]);
    };
    es.onopen = () => {
      const now = new Date().toLocaleTimeString();
      setSseRaw((prev) => [...prev.slice(-50), `[${now}] OPEN: SSE connected`]);
    };

    return () => es.close();
  }, [port]);

  // Auto-scroll log
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [logs, sseRaw]);

  const callApi = async () => {
    if (!port) return;
    try {
      const res = await fetch(`${getApiBaseUrl(port)}${apiEndpoint}`);
      const text = await res.text();
      try {
        setApiResponse(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        setApiResponse(text);
      }
    } catch (e) {
      setApiResponse(`Error: ${e}`);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* SSE State Summary */}
      <div className="app-panel p-4">
        <h3 className="mb-2 text-sm font-semibold text-stone-400">SSE State</h3>
        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
          <div>
            Connected:{" "}
            <span className={sse.connected ? "text-emerald-300" : "text-rose-300"}>
              {String(sse.connected)}
            </span>
          </div>
          <div>
            Status:{" "}
            <span className={sse.status === "up" ? "text-emerald-300" : sse.status === "down" ? "text-rose-300" : "text-amber-300"}>
              {sse.status}
            </span>
          </div>
          <div>Port: <span className="text-stone-200">{port ?? "null"}</span></div>
          <div>Active Targets: <span className="text-stone-200">{sse.lastPings.size}</span></div>
          <div>Ping History: <span className="text-stone-200">{sse.pingHistory.length}</span></div>
          <div>Outage Ranges: <span className="text-stone-200">{sse.outageRanges.length}</span></div>
          <div>Active Outage: <span className="text-stone-200">{sse.activeOutage ? "YES" : "none"}</span></div>
          <div>Speed Test Running: <span className="text-stone-200">{String(sse.speedTestRunning)}</span></div>
          <div>Stats Update: <span className="text-stone-200">{sse.statsUpdate ? "received" : "none"}</span></div>
        </div>
      </div>

      {/* Raw SSE Events */}
      <div className="app-panel p-4">
        <h3 className="mb-2 text-sm font-semibold text-stone-400">
          Raw SSE Events ({sseRaw.length})
        </h3>
        <div
          ref={logRef}
          className="h-48 overflow-y-auto rounded-2xl border border-stone-800 bg-stone-950 p-3 text-xs font-mono text-stone-300"
        >
          {sseRaw.length === 0 ? (
            <div className="text-stone-600">Waiting for events...</div>
          ) : (
            sseRaw.map((line, i) => <div key={i}>{line}</div>)
          )}
        </div>
      </div>

      {/* API Tester */}
      <div className="app-panel p-4">
        <h3 className="mb-2 text-sm font-semibold text-stone-400">API Tester</h3>
        <div className="flex gap-2">
          <select
            value={apiEndpoint}
            onChange={(e) => setApiEndpoint(e.target.value)}
            className="app-input"
          >
            <option value="/api/status">GET /api/status</option>
            <option value="/api/pings?limit=5">GET /api/pings?limit=5</option>
            <option value="/api/outages?limit=5">GET /api/outages?limit=5</option>
            <option value="/api/stats?window=300">GET /api/stats?window=300</option>
            <option value="/api/stats/summary">GET /api/stats/summary</option>
            <option value="/api/speed-tests?limit=5">GET /api/speed-tests?limit=5</option>
            <option value="/api/heatmap?days=7">GET /api/heatmap?days=7</option>
            <option value="/api/config">GET /api/config</option>
          </select>
          <button
            onClick={callApi}
            className="app-button-primary px-3 py-1"
          >
            Send
          </button>
        </div>
        {apiResponse && (
          <pre className="mt-2 max-h-64 overflow-auto rounded-2xl border border-stone-800 bg-stone-950 p-3 text-xs font-mono text-stone-300">
            {apiResponse}
          </pre>
        )}
      </div>
    </div>
  );
}
