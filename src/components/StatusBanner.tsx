import { useEffect, useState } from "react";
import type { PingResultEvent, ActiveOutage } from "../hooks/useSSE";

interface StatusBannerProps {
  status: "up" | "down" | "unknown";
  lastPings: Map<string, PingResultEvent>;
  activeOutage: ActiveOutage | null;
  connected: boolean;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  return `${ms.toFixed(1)}ms`;
}

function timeAgo(timestamp: string): string {
  const diff = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default function StatusBanner({
  status,
  lastPings,
  activeOutage,
  connected,
}: StatusBannerProps) {
  const [elapsed, setElapsed] = useState(0);
  const [, setTick] = useState(0);

  // Live timer for outage duration
  useEffect(() => {
    if (!activeOutage) {
      setElapsed(0);
      return;
    }
    const start = new Date(activeOutage.started_at).getTime();
    const update = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [activeOutage]);

  // Tick for "time ago" updates
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const isDown = status === "down";
  const pings = Array.from(lastPings.values());
  const latestPing = pings.length > 0
    ? pings.reduce((a, b) =>
        new Date(a.timestamp) > new Date(b.timestamp) ? a : b,
      )
    : null;

  if (status === "unknown") {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-4">
        <div className="flex items-center gap-3">
          <div className="h-3 w-3 rounded-full bg-gray-500 animate-pulse" />
          <span className="text-lg font-semibold text-gray-400">
            {connected ? "Waiting for data…" : "Connecting…"}
          </span>
        </div>
      </div>
    );
  }

  if (isDown && activeOutage) {
    return (
      <div className="rounded-lg border border-red-500/50 bg-red-900/30 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-3 w-3 rounded-full bg-red-500 animate-pulse" />
            <span className="text-lg font-bold text-red-400">
              Outage Detected
            </span>
            <span className="rounded bg-red-800/60 px-2 py-0.5 text-xs font-medium uppercase text-red-300">
              {activeOutage.cause}
            </span>
          </div>
          <span className="font-mono text-2xl font-bold text-red-300">
            {formatDuration(elapsed)}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-4 text-sm text-red-300/80">
          <span>
            Targets down:{" "}
            {activeOutage.targets_down.join(", ")}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-green-500/50 bg-green-900/30 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-3 w-3 rounded-full bg-green-500" />
          <span className="text-lg font-bold text-green-400">Connected</span>
        </div>
        {latestPing && (
          <div className="flex items-center gap-4 text-sm text-green-300/80">
            <span>
              {formatLatency(latestPing.latency_ms)} to {latestPing.target}
            </span>
            <span>{timeAgo(latestPing.timestamp)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
