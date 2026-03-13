import { useEffect, useState } from "react";
import { useStatsSummary } from "../hooks/useApi";
import type { StatsUpdateEvent } from "../hooks/useSSE";
import type { StatsSummary } from "../api";

interface Props {
  port: number | null;
  statsUpdate: StatsUpdateEvent | null;
}

interface StatCard {
  label: string;
  value: string;
  color: string;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "--";
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function uptimeColor(pct: number): string {
  if (pct >= 99.9) return "text-green-400";
  if (pct >= 99) return "text-yellow-400";
  return "text-red-400";
}

function cardBg(color: string): string {
  if (color.includes("green")) return "bg-green-950/30";
  if (color.includes("yellow")) return "bg-yellow-950/30";
  if (color.includes("red")) return "bg-red-950/30";
  if (color.includes("blue")) return "bg-blue-950/30";
  if (color.includes("purple")) return "bg-purple-950/30";
  return "bg-gray-800/50";
}

function buildCards(
  summary: StatsSummary,
  live: StatsUpdateEvent | null,
): StatCard[] {
  const jitter = live?.jitter_ms ?? summary.jitter_ms;
  const pktLoss = live?.packet_loss_pct ?? summary.packet_loss_pct;
  const p95 = live?.latency_p95 ?? summary.latency_p95;

  return [
    {
      label: "Uptime (1h)",
      value: `${summary.uptime_1h.toFixed(2)}%`,
      color: uptimeColor(summary.uptime_1h),
    },
    {
      label: "Uptime (24h)",
      value: `${summary.uptime_24h.toFixed(2)}%`,
      color: uptimeColor(summary.uptime_24h),
    },
    {
      label: "Uptime (7d)",
      value: `${summary.uptime_7d.toFixed(2)}%`,
      color: uptimeColor(summary.uptime_7d),
    },
    {
      label: "MTBF",
      value: formatDuration(summary.mtbf_s),
      color: "text-blue-400",
    },
    {
      label: "MTTR",
      value: formatDuration(summary.mttr_s),
      color: "text-purple-400",
    },
    {
      label: "Outages Today",
      value: String(summary.outage_count_today),
      color:
        summary.outage_count_today === 0 ? "text-green-400" : "text-red-400",
    },
    {
      label: "Jitter",
      value: `${jitter.toFixed(1)} ms`,
      color: jitter < 5 ? "text-green-400" : "text-yellow-400",
    },
    {
      label: "Packet Loss",
      value: `${pktLoss.toFixed(2)}%`,
      color: pktLoss < 1 ? "text-green-400" : "text-red-400",
    },
    {
      label: "Latency P95",
      value: `${p95.toFixed(1)} ms`,
      color: p95 < 100 ? "text-blue-400" : "text-yellow-400",
    },
  ];
}

export default function StatsPanel({ port, statsUpdate }: Props) {
  const { data: summary, refetch } = useStatsSummary(port);
  const [cards, setCards] = useState<StatCard[]>([]);

  // Refresh summary periodically when we get stats_update events
  useEffect(() => {
    if (statsUpdate) {
      refetch();
    }
  }, [statsUpdate, refetch]);

  useEffect(() => {
    if (summary) {
      setCards(buildCards(summary, statsUpdate));
    }
  }, [summary, statsUpdate]);

  if (!summary) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
        <p className="text-center text-sm text-gray-500">
          Loading statistics...
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <h3 className="mb-3 text-sm font-medium text-gray-300">
        Connection Statistics
      </h3>
      <div className="grid grid-cols-3 gap-3">
        {cards.map((card) => (
          <div
            key={card.label}
            className={`rounded-lg p-3 ${cardBg(card.color)}`}
          >
            <div className={`text-2xl font-bold ${card.color}`}>
              {card.value}
            </div>
            <div className="mt-1 text-xs text-gray-400">{card.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
