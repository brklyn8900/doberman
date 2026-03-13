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
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<SpeedTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  // Sync SSE running state
  useEffect(() => {
    setRunning(speedTestRunning);
  }, [speedTestRunning]);

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
      setRunning(false);
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
    setRunning(true);
    setError(null);
    try {
      const result = await triggerSpeedTest(port);
      setLastResult(result);
      setCooldown(COOLDOWN_S);
      refetch();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
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
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <div className="flex items-center gap-4">
          <button
            onClick={handleRun}
            disabled={running || cooldown > 0 || !port}
            className={`rounded-lg px-5 py-2.5 text-sm font-medium transition-colors ${
              running || cooldown > 0
                ? "cursor-not-allowed bg-gray-700 text-gray-400"
                : "bg-blue-600 text-white hover:bg-blue-500"
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
            <span className="text-sm text-red-400">{error}</span>
          )}
        </div>

        {lastResult && (
          <div className="mt-4 grid grid-cols-4 gap-4">
            <div className="rounded bg-gray-800 p-3 text-center">
              <div className="text-2xl font-bold text-green-400">
                {lastResult.download_mbps.toFixed(1)}
              </div>
              <div className="text-xs text-gray-400">Download Mbps</div>
            </div>
            <div className="rounded bg-gray-800 p-3 text-center">
              <div className="text-2xl font-bold text-blue-400">
                {lastResult.upload_mbps.toFixed(1)}
              </div>
              <div className="text-xs text-gray-400">Upload Mbps</div>
            </div>
            <div className="rounded bg-gray-800 p-3 text-center">
              <div className="text-2xl font-bold text-yellow-400">
                {lastResult.ping_ms.toFixed(0)}
              </div>
              <div className="text-xs text-gray-400">Ping ms</div>
            </div>
            <div className="rounded bg-gray-800 p-3 text-center">
              <div className="truncate text-sm font-medium text-gray-300">
                {lastResult.server_name}
              </div>
              <div className="text-xs text-gray-400">Server</div>
            </div>
          </div>
        )}
      </div>

      {/* Chart */}
      {chartData.length > 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <h3 className="mb-3 text-sm font-medium text-gray-300">
            Speed History
          </h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="time"
                tick={{ fill: "#9ca3af", fontSize: 11 }}
                tickLine={{ stroke: "#4b5563" }}
              />
              <YAxis
                tick={{ fill: "#9ca3af", fontSize: 11 }}
                tickLine={{ stroke: "#4b5563" }}
                label={{
                  value: "Mbps",
                  angle: -90,
                  position: "insideLeft",
                  fill: "#6b7280",
                  fontSize: 11,
                }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#1f2937",
                  border: "1px solid #374151",
                  borderRadius: 6,
                  color: "#e5e7eb",
                }}
              />
              <Legend wrapperStyle={{ color: "#9ca3af", fontSize: 12 }} />
              <Bar dataKey="Download" fill="#34d399" radius={[2, 2, 0, 0]} />
              <Bar dataKey="Upload" fill="#60a5fa" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* History table */}
      {tests.length > 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <h3 className="mb-3 text-sm font-medium text-gray-300">
            Test History
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-xs text-gray-400">
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
                    className="border-b border-gray-800/50 text-gray-300"
                  >
                    <td className="py-1.5 pr-4 text-xs text-gray-400">
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
                      <span className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-400">
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
        <div className="flex items-center justify-center rounded-lg border border-gray-800 bg-gray-900 p-8">
          <p className="text-sm text-gray-500">
            No speed test results yet. Run a test to get started.
          </p>
        </div>
      )}
    </div>
  );
}
