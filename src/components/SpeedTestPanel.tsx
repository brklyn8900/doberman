import { useState, useEffect, useCallback } from "react";
import { format } from "date-fns";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { triggerSpeedTest, type SpeedTestResult } from "../api";
import { useSpeedTests } from "../hooks/useApi";
import type { SpeedTestResultEvent } from "../hooks/useSSE";

interface Props {
  port: number | null;
  speedTestRunning: boolean;
  lastSpeedTestResult: SpeedTestResultEvent | null;
}

const COOLDOWN_S = 60;

export default function SpeedTestPanel({
  port,
  speedTestRunning,
  lastSpeedTestResult,
}: Props) {
  const { data, refetch } = useSpeedTests(port);
  const [manualRunPending, setManualRunPending] = useState(false);
  const [lastResult, setLastResult] = useState<SpeedTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const running = manualRunPending || speedTestRunning;

  // When SSE delivers a result, refresh history and show it
  useEffect(() => {
    if (lastSpeedTestResult) {
      setLastResult({
        id: lastSpeedTestResult.id,
        timestamp: lastSpeedTestResult.timestamp,
        download_mbps: lastSpeedTestResult.download_mbps,
        upload_mbps: lastSpeedTestResult.upload_mbps,
        ping_ms: lastSpeedTestResult.ping_ms,
        server_name: lastSpeedTestResult.server_name,
        trigger: lastSpeedTestResult.trigger,
      });
      setManualRunPending(false);
      setCooldown(COOLDOWN_S);
      refetch();
    }
  }, [lastSpeedTestResult, refetch]);

  // Cooldown countdown
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((c) => c - 1), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  const handleRun = useCallback(async () => {
    if (!port || running || cooldown > 0) return;
    setManualRunPending(true);
    setError(null);
    try {
      const result = await triggerSpeedTest(port);
      setLastResult(result);
      setCooldown(COOLDOWN_S);
      refetch();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setManualRunPending(false);
    }
  }, [port, running, cooldown, refetch]);

  const tests = data?.tests ?? [];

  const chartData = [...tests]
    .slice(-20)
    .map((t) => ({
      time: format(new Date(t.timestamp), "MM/dd HH:mm"),
      Download: t.download_mbps,
      Upload: t.upload_mbps,
    }));

  return (
    <div className="flex flex-col gap-4">
      {/* Run button + last result */}
      <div className="app-panel p-5">
        <div className="flex items-center gap-4">
          <button
            onClick={handleRun}
            disabled={running || cooldown > 0 || !port}
            className={`rounded-xl px-5 py-2.5 text-sm font-medium transition-colors ${
              running || cooldown > 0
                ? "cursor-not-allowed border border-stone-700 bg-stone-800 text-stone-500"
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            }`}
          >
            {running ? (
              <span className="flex items-center gap-2">
                <svg
                  className="h-4 w-4 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Running...
              </span>
            ) : cooldown > 0 ? (
              `Wait ${cooldown}s`
            ) : (
              "Run Speed Test"
            )}
          </button>

          {error && (
            <span className="text-sm text-rose-300">{error}</span>
          )}
        </div>

        {lastResult && (
          <div className="mt-4 grid gap-4 md:grid-cols-4">
            <div className="rounded-2xl border border-stone-800 bg-stone-950/80 p-3 text-center">
              <div className="text-2xl font-bold text-emerald-300">
                {lastResult.download_mbps.toFixed(1)}
              </div>
              <div className="text-xs text-stone-500">Download Mbps</div>
            </div>
            <div className="rounded-2xl border border-stone-800 bg-stone-950/80 p-3 text-center">
              <div className="text-2xl font-bold text-stone-100">
                {lastResult.upload_mbps.toFixed(1)}
              </div>
              <div className="text-xs text-stone-500">Upload Mbps</div>
            </div>
            <div className="rounded-2xl border border-stone-800 bg-stone-950/80 p-3 text-center">
              <div className="text-2xl font-bold text-amber-300">
                {lastResult.ping_ms.toFixed(0)}
              </div>
              <div className="text-xs text-stone-500">Ping ms</div>
            </div>
            <div className="rounded-2xl border border-stone-800 bg-stone-950/80 p-3 text-center">
              <div className="truncate text-sm font-medium text-stone-200">
                {lastResult.server_name ?? "Unknown server"}
              </div>
              <div className="text-xs text-stone-500">Server</div>
            </div>
          </div>
        )}
      </div>

      {/* Chart */}
      {chartData.length > 0 && (
        <div className="app-panel p-5">
          <h3 className="mb-3 text-sm font-medium text-stone-300">
            Speed History
          </h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#44403c" />
              <XAxis
                dataKey="time"
                tick={{ fill: "#a8a29e", fontSize: 11 }}
                tickLine={{ stroke: "#57534e" }}
              />
              <YAxis
                tick={{ fill: "#a8a29e", fontSize: 11 }}
                tickLine={{ stroke: "#57534e" }}
                label={{
                  value: "Mbps",
                  angle: -90,
                  position: "insideLeft",
                  fill: "#78716c",
                  fontSize: 11,
                }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#1c1917",
                  border: "1px solid #44403c",
                  borderRadius: 12,
                  color: "#fafaf9",
                }}
              />
              <Legend wrapperStyle={{ color: "#a8a29e", fontSize: 12 }} />
              <Bar dataKey="Download" fill="#34d399" radius={[2, 2, 0, 0]} />
              <Bar dataKey="Upload" fill="#d6d3d1" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* History table */}
      {tests.length > 0 && (
        <div className="app-panel p-5">
          <h3 className="mb-3 text-sm font-medium text-stone-300">
            Test History
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-stone-800 text-xs text-stone-500">
                  <th className="pb-2 pr-4">Timestamp</th>
                  <th className="pb-2 pr-4 text-right">Download</th>
                  <th className="pb-2 pr-4 text-right">Upload</th>
                  <th className="pb-2 pr-4 text-right">Ping</th>
                  <th className="pb-2">Trigger</th>
                </tr>
              </thead>
              <tbody>
                {tests.map((t) => (
                  <tr
                    key={t.id}
                    className="border-b border-stone-800/60 text-stone-300"
                  >
                    <td className="py-1.5 pr-4 text-xs text-stone-500">
                      {format(new Date(t.timestamp), "yyyy-MM-dd HH:mm:ss")}
                    </td>
                    <td className="py-1.5 pr-4 text-right font-mono">
                      {t.download_mbps.toFixed(1)}
                    </td>
                    <td className="py-1.5 pr-4 text-right font-mono">
                      {t.upload_mbps.toFixed(1)}
                    </td>
                    <td className="py-1.5 pr-4 text-right font-mono">
                      {t.ping_ms.toFixed(0)}
                    </td>
                    <td className="py-1.5">
                      <span className="app-chip">
                        {t.trigger}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tests.length === 0 && !lastResult && (
        <div className="app-panel flex items-center justify-center p-8">
          <p className="text-sm text-stone-500">
            No speed test results yet. Run a test to get started.
          </p>
        </div>
      )}
    </div>
  );
}
