import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
} from "recharts";
import { format } from "date-fns";
import type { PingResultEvent } from "../hooks/useSSE";

interface LiveChartProps {
  pingHistory: PingResultEvent[];
  outageRanges: Array<{ start: string; end: string | null }>;
}

interface ChartPoint {
  time: number;
  timeLabel: string;
  [target: string]: number | string;
}

const TARGET_COLORS = [
  "#d6d3d1",
  "#a8a29e",
  "#f59e0b",
  "#34d399",
  "#fda4af",
  "#7dd3fc",
];

export default function LiveChart({ pingHistory, outageRanges }: LiveChartProps) {
  const { data, targets } = useMemo(() => {
    const targetSet = new Set<string>();
    const pointMap = new Map<number, ChartPoint>();

    for (const ping of pingHistory) {
      targetSet.add(ping.target);
      const ts = Math.floor(new Date(ping.timestamp).getTime() / 1000) * 1000;

      let point = pointMap.get(ts);
      if (!point) {
        point = {
          time: ts,
          timeLabel: format(new Date(ts), "HH:mm:ss"),
        };
        pointMap.set(ts, point);
      }

      if (ping.success && ping.latency_ms !== null) {
        point[ping.target] = ping.latency_ms;
      }
    }

    const sorted = Array.from(pointMap.values()).sort(
      (a, b) => a.time - b.time,
    );

    return { data: sorted, targets: Array.from(targetSet) };
  }, [pingHistory]);

  const outageAreas = useMemo(() => {
    if (data.length === 0) return [];
    const chartStart = data[0].time;
    const chartEnd = data[data.length - 1].time;

    return outageRanges
      .map((r) => {
        const start = new Date(r.start).getTime();
        const end = r.end ? new Date(r.end).getTime() : Date.now();
        const x1 = Math.max(start, chartStart);
        const x2 = Math.min(end, chartEnd);
        if (x1 >= x2) return null;
        return { x1, x2 };
      })
      .filter((r): r is { x1: number; x2: number } => r !== null);
  }, [data, outageRanges]);

  if (data.length === 0) {
    return (
      <div className="app-panel flex h-64 items-center justify-center text-stone-500">
        Waiting for ping data…
      </div>
    );
  }

  return (
    <div className="app-panel p-5">
      <h3 className="mb-3 text-sm font-medium text-stone-300">
        Latency (last 10 minutes)
      </h3>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#44403c" />
          <XAxis
            dataKey="timeLabel"
            stroke="#78716c"
            tick={{ fill: "#a8a29e", fontSize: 11 }}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke="#78716c"
            tick={{ fill: "#a8a29e", fontSize: 11 }}
            label={{
              value: "ms",
              angle: -90,
              position: "insideLeft",
              fill: "#a8a29e",
              fontSize: 11,
            }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#1c1917",
              border: "1px solid #44403c",
              borderRadius: "0.75rem",
              color: "#fafaf9",
              fontSize: 12,
            }}
            labelStyle={{ color: "#a8a29e" }}
          />
          {outageAreas.map((area, i) => (
            <ReferenceArea
              key={i}
              x1={area.x1}
              x2={area.x2}
              fill="rgba(239,68,68,0.15)"
              strokeOpacity={0}
            />
          ))}
          {targets.map((target, i) => (
            <Line
              key={target}
              type="monotone"
              dataKey={target}
              stroke={TARGET_COLORS[i % TARGET_COLORS.length]}
              strokeWidth={1.5}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        {targets.map((target, i) => (
          <div key={target} className="flex items-center gap-1.5">
            <div
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: TARGET_COLORS[i % TARGET_COLORS.length] }}
            />
            <span className="text-stone-400">{target}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
