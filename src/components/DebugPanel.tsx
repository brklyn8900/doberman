import { useState, useEffect, useRef } from "react";
import { SSEState } from "../hooks/useSSE";

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
          data: `${target}: ${ping.success ? `${ping.latency_ms?.toFixed(1)}ms` : `FAIL ${ping.error}`}`,
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
    const es = new EventSource(`http://localhost:${port}/api/events`);

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
      const res = await fetch(`http://localhost:${port}${apiEndpoint}`);
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
      <div className="rounded border border-gray-700 bg-gray-900 p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-400">SSE State</h3>
        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
          <div>
            Connected:{" "}
            <span className={sse.connected ? "text-green-400" : "text-red-400"}>
              {String(sse.connected)}
            </span>
          </div>
          <div>
            Status:{" "}
            <span className={sse.status === "up" ? "text-green-400" : sse.status === "down" ? "text-red-400" : "text-yellow-400"}>
              {sse.status}
            </span>
          </div>
          <div>Port: <span className="text-blue-400">{port ?? "null"}</span></div>
          <div>Active Targets: <span className="text-blue-400">{sse.lastPings.size}</span></div>
          <div>Ping History: <span className="text-blue-400">{sse.pingHistory.length}</span></div>
          <div>Outage Ranges: <span className="text-blue-400">{sse.outageRanges.length}</span></div>
          <div>Active Outage: <span className="text-blue-400">{sse.activeOutage ? "YES" : "none"}</span></div>
          <div>Speed Test Running: <span className="text-blue-400">{String(sse.speedTestRunning)}</span></div>
          <div>Stats Update: <span className="text-blue-400">{sse.statsUpdate ? "received" : "none"}</span></div>
        </div>
      </div>

      {/* Raw SSE Events */}
      <div className="rounded border border-gray-700 bg-gray-900 p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-400">
          Raw SSE Events ({sseRaw.length})
        </h3>
        <div
          ref={logRef}
          className="h-48 overflow-y-auto rounded bg-black p-2 text-xs font-mono text-green-400"
        >
          {sseRaw.length === 0 ? (
            <div className="text-gray-600">Waiting for events...</div>
          ) : (
            sseRaw.map((line, i) => <div key={i}>{line}</div>)
          )}
        </div>
      </div>

      {/* API Tester */}
      <div className="rounded border border-gray-700 bg-gray-900 p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-400">API Tester</h3>
        <div className="flex gap-2">
          <select
            value={apiEndpoint}
            onChange={(e) => setApiEndpoint(e.target.value)}
            className="rounded bg-gray-800 px-2 py-1 text-sm text-gray-200"
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
            className="rounded bg-blue-600 px-3 py-1 text-sm font-medium hover:bg-blue-500"
          >
            Send
          </button>
        </div>
        {apiResponse && (
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-black p-2 text-xs font-mono text-gray-300">
            {apiResponse}
          </pre>
        )}
      </div>
    </div>
  );
}
