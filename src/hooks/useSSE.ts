import { useEffect, useRef, useState, useCallback } from "react";

export interface PingResultEvent {
  type: "ping_result";
  target: string;
  success: boolean;
  latency_ms: number | null;
  dns_ms: number | null;
  timestamp: string;
}

export interface OutageStartEvent {
  type: "outage_start";
  outage_id: number;
  started_at: string;
  targets_down: string[];
  cause: string;
}

export interface OutageEndEvent {
  type: "outage_end";
  outage_id: number;
  started_at: string;
  ended_at: string;
  duration_s: number;
}

export interface StatsUpdateEvent {
  type: "stats_update";
  window_s: number;
  packet_loss_pct: number;
  jitter_ms: number;
  latency_p50: number;
  latency_p95: number;
  latency_p99: number;
}

export interface StatusChangeEvent {
  type: "status_change";
  status: "up" | "down";
  timestamp: string;
}

export interface SpeedTestStartEvent {
  type: "speed_test_start";
  timestamp: string;
}

export interface SpeedTestResultEvent {
  type: "speed_test_result";
  id: number;
  timestamp: string;
  download_mbps: number;
  upload_mbps: number;
  ping_ms: number;
  server_name: string;
  trigger: string;
}

export type SseEvent =
  | PingResultEvent
  | OutageStartEvent
  | OutageEndEvent
  | StatsUpdateEvent
  | StatusChangeEvent
  | SpeedTestStartEvent
  | SpeedTestResultEvent;

export interface ActiveOutage {
  outage_id: number;
  started_at: string;
  targets_down: string[];
  cause: string;
}

export interface SSEState {
  connected: boolean;
  status: "up" | "down" | "unknown";
  lastPings: Map<string, PingResultEvent>;
  activeOutage: ActiveOutage | null;
  pingHistory: PingResultEvent[];
  outageRanges: Array<{ start: string; end: string | null }>;
  speedTestRunning: boolean;
  lastSpeedTestResult: SpeedTestResultEvent | null;
  statsUpdate: StatsUpdateEvent | null;
}

const TEN_MINUTES_MS = 10 * 60 * 1000;
const MAX_HISTORY = 600;

export function useSSE(port: number | null): SSEState {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<"up" | "down" | "unknown">("unknown");
  const [lastPings, setLastPings] = useState<Map<string, PingResultEvent>>(
    () => new Map(),
  );
  const [activeOutage, setActiveOutage] = useState<ActiveOutage | null>(null);
  const [pingHistory, setPingHistory] = useState<PingResultEvent[]>([]);
  const [outageRanges, setOutageRanges] = useState<
    Array<{ start: string; end: string | null }>
  >([]);
  const [speedTestRunning, setSpeedTestRunning] = useState(false);
  const [lastSpeedTestResult, setLastSpeedTestResult] =
    useState<SpeedTestResultEvent | null>(null);
  const [statsUpdate, setStatsUpdate] = useState<StatsUpdateEvent | null>(null);

  const retryDelay = useRef(1000);
  const esRef = useRef<EventSource | null>(null);

  const trimHistory = useCallback((history: PingResultEvent[]): PingResultEvent[] => {
    const now = Date.now();
    const filtered = history.filter(
      (p) => now - new Date(p.timestamp).getTime() < TEN_MINUTES_MS,
    );
    if (filtered.length > MAX_HISTORY) {
      return filtered.slice(filtered.length - MAX_HISTORY);
    }
    return filtered;
  }, []);

  useEffect(() => {
    if (port === null) return;

    let unmounted = false;

    function connect() {
      if (unmounted) return;

      const es = new EventSource(`http://localhost:${port}/api/events`);
      esRef.current = es;

      es.onopen = () => {
        if (unmounted) return;
        setConnected(true);
        retryDelay.current = 1000;
      };

      // Handler for all named SSE event types
      const handleEvent = (event: MessageEvent) => {
        if (unmounted) return;
        try {
          const data = JSON.parse(event.data) as SseEvent;

          switch (data.type) {
            case "ping_result":
              setLastPings((prev) => {
                const next = new Map(prev);
                next.set(data.target, data);
                return next;
              });
              setPingHistory((prev) => trimHistory([...prev, data]));
              // Set status to "up" when we get successful pings
              setStatus((prev) => prev === "unknown" ? "up" : prev);
              break;

            case "status_change":
              setStatus(data.status);
              break;

            case "outage_start":
              setActiveOutage({
                outage_id: data.outage_id,
                started_at: data.started_at,
                targets_down: data.targets_down,
                cause: data.cause,
              });
              setStatus("down");
              setOutageRanges((prev) => [
                ...prev,
                { start: data.started_at, end: null },
              ]);
              break;

            case "outage_end":
              setActiveOutage(null);
              setStatus("up");
              setOutageRanges((prev) =>
                prev.map((r) =>
                  r.end === null ? { ...r, end: data.ended_at } : r,
                ),
              );
              break;

            case "speed_test_start":
              setSpeedTestRunning(true);
              break;

            case "speed_test_result":
              setSpeedTestRunning(false);
              setLastSpeedTestResult(data);
              break;

            case "stats_update":
              setStatsUpdate(data);
              break;
          }
        } catch {
          // ignore malformed events
        }
      };

      // Listen for named SSE events (the backend sends event: <name>)
      const eventTypes = [
        "ping_result",
        "outage_start",
        "outage_end",
        "stats_update",
        "status_change",
        "speed_test_start",
        "speed_test_result",
      ];
      for (const t of eventTypes) {
        es.addEventListener(t, handleEvent as EventListener);
      }

      es.onerror = () => {
        if (unmounted) return;
        setConnected(false);
        es.close();
        esRef.current = null;
        const delay = retryDelay.current;
        retryDelay.current = Math.min(delay * 2, 30000);
        setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      unmounted = true;
      esRef.current?.close();
      esRef.current = null;
    };
  }, [port, trimHistory]);

  return {
    connected,
    status,
    lastPings,
    activeOutage,
    pingHistory,
    outageRanges,
    speedTestRunning,
    lastSpeedTestResult,
    statsUpdate,
  };
}
