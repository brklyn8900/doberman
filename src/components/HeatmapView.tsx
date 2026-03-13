import { useState, useEffect, useMemo } from "react";
import { fetchHeatmap, type HeatmapCell } from "../api";

interface Props {
  port: number | null;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function colorForValue(value: number, max: number): string {
  if (value === 0 || max === 0) return "bg-gray-800";
  const ratio = value / max;
  if (ratio < 0.25) return "bg-yellow-900/60";
  if (ratio < 0.5) return "bg-yellow-700/60";
  if (ratio < 0.75) return "bg-orange-600/60";
  return "bg-red-600/70";
}

export default function HeatmapView({ port }: Props) {
  const [days, setDays] = useState<7 | 30>(7);
  const [cells, setCells] = useState<HeatmapCell[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    cell: HeatmapCell;
  } | null>(null);

  useEffect(() => {
    if (port === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchHeatmap(port, days)
      .then((data) => {
        if (!cancelled) setCells(data.cells);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [port, days]);

  const { grid, dates, maxValue } = useMemo(() => {
    const dateSet = new Set<string>();
    const map = new Map<string, HeatmapCell>();

    for (const cell of cells) {
      dateSet.add(cell.date);
      map.set(`${cell.date}-${cell.hour}`, cell);
    }

    const sortedDates = Array.from(dateSet).sort();
    let maxVal = 0;
    for (const cell of cells) {
      const v = cell.outage_count + cell.downtime_minutes;
      if (v > maxVal) maxVal = v;
    }

    return { grid: map, dates: sortedDates, maxValue: maxVal };
  }, [cells]);

  return (
    <div className="flex flex-col gap-4">
      {/* Toggle */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setDays(7)}
          className={`rounded px-3 py-1.5 text-sm transition-colors ${
            days === 7
              ? "bg-gray-700 font-medium text-white"
              : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
          }`}
        >
          7 Days
        </button>
        <button
          onClick={() => setDays(30)}
          className={`rounded px-3 py-1.5 text-sm transition-colors ${
            days === 30
              ? "bg-gray-700 font-medium text-white"
              : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
          }`}
        >
          30 Days
        </button>
      </div>

      {loading && <p className="text-sm text-gray-500">Loading heatmap…</p>}
      {error && <p className="text-sm text-red-400">Error: {error}</p>}

      {!loading && !error && (
        <div className="relative overflow-x-auto">
          {/* Hour labels */}
          <div className="mb-1 ml-24 grid grid-cols-24 gap-px">
            {HOURS.map((h) => (
              <div key={h} className="text-center text-[10px] text-gray-500">
                {h}
              </div>
            ))}
          </div>

          {/* Grid rows */}
          <div className="flex flex-col gap-px">
            {dates.map((date) => (
              <div key={date} className="flex items-center gap-px">
                <div className="w-24 flex-shrink-0 pr-2 text-right text-xs text-gray-400">
                  {new Date(date + "T00:00:00").toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}
                </div>
                <div className="grid flex-1 grid-cols-24 gap-px">
                  {HOURS.map((hour) => {
                    const cell = grid.get(`${date}-${hour}`);
                    const count = cell?.outage_count ?? 0;
                    const downtime = cell?.downtime_minutes ?? 0;
                    const value = count + downtime;
                    return (
                      <div
                        key={hour}
                        className={`aspect-square rounded-sm ${colorForValue(value, maxValue)} transition-colors`}
                        onMouseEnter={(e) => {
                          if (cell) {
                            const rect = e.currentTarget.getBoundingClientRect();
                            setTooltip({
                              x: rect.left + rect.width / 2,
                              y: rect.top,
                              cell,
                            });
                          }
                        }}
                        onMouseLeave={() => setTooltip(null)}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Legend */}
          <div className="mt-3 flex items-center gap-2 text-xs text-gray-500">
            <span>Less</span>
            <div className="h-3 w-3 rounded-sm bg-gray-800" />
            <div className="h-3 w-3 rounded-sm bg-yellow-900/60" />
            <div className="h-3 w-3 rounded-sm bg-yellow-700/60" />
            <div className="h-3 w-3 rounded-sm bg-orange-600/60" />
            <div className="h-3 w-3 rounded-sm bg-red-600/70" />
            <span>More</span>
          </div>

          {/* Tooltip */}
          {tooltip && (
            <div
              className="pointer-events-none fixed z-50 rounded border border-gray-700 bg-gray-900 px-3 py-2 text-xs shadow-lg"
              style={{
                left: tooltip.x,
                top: tooltip.y - 8,
                transform: "translate(-50%, -100%)",
              }}
            >
              <p className="font-medium text-gray-200">
                {tooltip.cell.date} — {String(tooltip.cell.hour).padStart(2, "0")}:00
              </p>
              <p className="text-gray-400">
                Outages: <span className="text-gray-200">{tooltip.cell.outage_count}</span>
              </p>
              <p className="text-gray-400">
                Downtime: <span className="text-gray-200">{tooltip.cell.downtime_minutes}m</span>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
