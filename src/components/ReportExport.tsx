import { useState, useEffect } from "react";
import { fetchStatsSummaryFull, exportCsv, exportReport, type StatsSummary } from "../api";

interface Props {
  port: number | null;
}

export default function ReportExport({ port }: Props) {
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().split("T")[0]);
  const [stats, setStats] = useState<StatsSummary | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (port === null) return;
    let cancelled = false;
    setLoadingStats(true);
    setError(null);

    fetchStatsSummaryFull(port)
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingStats(false);
      });

    return () => {
      cancelled = true;
    };
  }, [port, dateFrom, dateTo]);

  const handleExportCsv = async () => {
    if (port === null) return;
    setExportingCsv(true);
    try {
      await exportCsv(port, dateFrom, dateTo);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExportingCsv(false);
    }
  };

  const handleExportPdf = async () => {
    if (port === null) return;
    setExportingPdf(true);
    try {
      await exportReport(port, dateFrom, dateTo);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExportingPdf(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Date Range */}
      <div className="flex items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          From
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-sm text-gray-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          To
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-sm text-gray-100"
          />
        </label>
      </div>

      {/* Preview Stats */}
      <div className="rounded border border-gray-800 bg-gray-900 p-4">
        <h3 className="mb-3 text-sm font-medium text-gray-300">Report Preview</h3>
        {loadingStats && <p className="text-sm text-gray-500">Loading stats…</p>}
        {error && <p className="text-sm text-red-400">Error: {error}</p>}
        {stats && !loadingStats && (
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded bg-gray-800/50 p-3">
              <p className="text-xs text-gray-500">Outages Today</p>
              <p className="text-xl font-semibold text-gray-100">
                {stats.outage_count_today}
              </p>
            </div>
            <div className="rounded bg-gray-800/50 p-3">
              <p className="text-xs text-gray-500">Uptime (24h)</p>
              <p className="text-xl font-semibold text-gray-100">
                {(stats.uptime_24h * 100).toFixed(2)}%
              </p>
            </div>
            <div className="rounded bg-gray-800/50 p-3">
              <p className="text-xs text-gray-500">Uptime (7d)</p>
              <p className="text-xl font-semibold text-gray-100">
                {(stats.uptime_7d * 100).toFixed(2)}%
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Export Buttons */}
      <div className="flex gap-3">
        <button
          onClick={handleExportCsv}
          disabled={exportingCsv || port === null}
          className="flex items-center gap-2 rounded bg-gray-700 px-4 py-2 text-sm font-medium text-gray-100 transition-colors hover:bg-gray-600 disabled:opacity-50"
        >
          {exportingCsv && (
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          Export CSV
        </button>
        <button
          onClick={handleExportPdf}
          disabled={exportingPdf || port === null}
          className="flex items-center gap-2 rounded bg-blue-700 px-4 py-2 text-sm font-medium text-gray-100 transition-colors hover:bg-blue-600 disabled:opacity-50"
        >
          {exportingPdf && (
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          Export PDF
        </button>
      </div>
    </div>
  );
}
