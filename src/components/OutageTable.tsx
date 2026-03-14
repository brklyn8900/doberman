import { useState, useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  getExpandedRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type ExpandedState,
  type PaginationState,
} from "@tanstack/react-table";
import { useOutages } from "../hooks/useApi";
import type { Outage } from "../api";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "Ongoing";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

const causeBadgeColor: Record<string, string> = {
  isp: "border border-rose-900 bg-rose-950/50 text-rose-200",
  local: "border border-amber-900 bg-amber-950/50 text-amber-200",
  unknown: "border border-stone-700 bg-stone-900/70 text-stone-300",
};

function CauseBadge({ cause }: { cause: string }) {
  const colors = causeBadgeColor[cause.toLowerCase()] ?? causeBadgeColor.unknown;
  return (
    <span className={`rounded border px-2 py-0.5 text-xs font-medium ${colors}`}>
      {cause}
    </span>
  );
}

const columnHelper = createColumnHelper<Outage>();

interface Props {
  port: number | null;
}

export default function OutageTable({ port }: Props) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [causeFilter, setCauseFilter] = useState("");
  const [minDuration, setMinDuration] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "started_at", desc: true },
  ]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });

  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (dateFrom) p.from = dateFrom;
    if (dateTo) p.to = dateTo;
    if (causeFilter) p.cause = causeFilter;
    return p;
  }, [dateFrom, dateTo, causeFilter]);

  const { data, loading, error } = useOutages(port, params);

  const filteredOutages = useMemo(() => {
    if (!data?.outages) return [];
    if (!minDuration) return data.outages;
    const minSec = parseFloat(minDuration) * 60;
    if (isNaN(minSec)) return data.outages;
    return data.outages.filter(
      (o) => o.duration_s === null || o.duration_s >= minSec,
    );
  }, [data, minDuration]);

  const columns = useMemo(
    () => [
      columnHelper.accessor("started_at", {
        header: "Start Time",
        cell: (info) => formatTime(info.getValue()),
      }),
      columnHelper.accessor("ended_at", {
        header: "End Time",
        cell: (info) => formatTime(info.getValue()),
      }),
      columnHelper.accessor("duration_s", {
        header: "Duration",
        cell: (info) => formatDuration(info.getValue()),
      }),
      columnHelper.accessor("cause", {
        header: "Cause",
        cell: (info) => <CauseBadge cause={info.getValue()} />,
      }),
      columnHelper.accessor("targets_down", {
        header: "Targets Down",
        cell: (info) => {
          const val = info.getValue();
          if (!val) return "—";
          const targets = val.split(",").map((t) => t.trim());
          return <span className="text-xs text-stone-400">{targets.length}</span>;
        },
      }),
      columnHelper.display({
        id: "expand",
        header: "",
        cell: ({ row }) => (
          <button
            onClick={(e) => {
              e.stopPropagation();
              row.toggleExpanded();
            }}
            className="text-xs text-stone-500 hover:text-stone-300"
          >
            {row.getIsExpanded() ? "▾" : "▸"}
          </button>
        ),
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: filteredOutages,
    columns,
    state: { sorting, expanded, pagination },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowCanExpand: () => true,
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="outage-from" className="text-xs text-stone-400">From</Label>
          <DatePicker
            id="outage-from"
            value={dateFrom}
            onChange={setDateFrom}
            placeholder="Select start"
            ariaLabel="Outage filter start date"
            className="w-[164px]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="outage-to" className="text-xs text-stone-400">To</Label>
          <DatePicker
            id="outage-to"
            value={dateTo}
            onChange={setDateTo}
            placeholder="Select end"
            ariaLabel="Outage filter end date"
            className="w-[164px]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="outage-cause" className="text-xs text-stone-400">Cause</Label>
          <Select value={causeFilter || "all"} onValueChange={(value) => setCauseFilter(value === "all" ? "" : value)}>
            <SelectTrigger id="outage-cause" className="w-[140px]">
              <SelectValue placeholder="All causes" />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="isp">ISP</SelectItem>
              <SelectItem value="local">Local</SelectItem>
              <SelectItem value="unknown">Unknown</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="outage-min-duration" className="text-xs text-stone-400">Min Duration (min)</Label>
          <Input
            id="outage-min-duration"
            type="number"
            min={0}
            step={1}
            value={minDuration}
            onChange={(e) => setMinDuration(e.target.value)}
            placeholder="0"
            className="w-28"
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setDateFrom("");
            setDateTo("");
            setCauseFilter("");
            setMinDuration("");
          }}
          className="mb-0.5"
        >
          Clear filters
        </Button>
      </div>

      {/* Table */}
      {loading && <p className="text-sm text-stone-500">Loading outages…</p>}
      {error && <p className="text-sm text-rose-300">Error: {error}</p>}
      {!loading && !error && (
        <div className="app-panel overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="border-b border-stone-800 bg-stone-900/80">
                  {hg.headers.map((header) => (
                    <th
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      className="cursor-pointer select-none px-3 py-2 text-left text-xs font-medium text-stone-400 hover:text-stone-200"
                    >
                      <div className="flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {{ asc: " ↑", desc: " ↓" }[
                          header.column.getIsSorted() as string
                        ] ?? ""}
                      </div>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.length === 0 && (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="px-3 py-8 text-center text-stone-500"
                  >
                    No outages found
                  </td>
                </tr>
              )}
              {table.getRowModel().rows.map((row) => (
                <>
                  <tr
                    key={row.id}
                    onClick={() => row.toggleExpanded()}
                    className="cursor-pointer border-b border-stone-800/60 hover:bg-stone-800/30"
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                  {row.getIsExpanded() && (
                    <tr key={`${row.id}-expanded`} className="border-b border-stone-800/60">
                      <td colSpan={columns.length} className="bg-stone-950/60 px-4 py-3">
                        <div className="flex flex-col gap-2">
                          <div className="text-xs text-stone-400">
                            <span className="font-medium text-stone-300">Targets:</span>{" "}
                            {row.original.targets_down || "—"}
                          </div>
                          {row.original.traceroute && (
                            <div>
                              <p className="mb-1 text-xs font-medium text-stone-300">
                                Traceroute
                              </p>
                              <pre className="max-h-60 overflow-auto rounded-2xl border border-stone-800 bg-stone-950 p-3 text-xs text-stone-400">
                                {row.original.traceroute}
                              </pre>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>

          {/* Pagination */}
          <div className="flex items-center justify-between border-t border-stone-800 bg-stone-900/80 px-3 py-2">
            <div className="flex items-center gap-2 text-xs text-stone-400">
              <span>Rows per page:</span>
              <Select
                value={String(pagination.pageSize)}
                onValueChange={(value) => table.setPageSize(Number(value))}
              >
                <SelectTrigger className="h-8 w-[88px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  {[10, 25, 50].map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="ml-2">
                {filteredOutages.length} total
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
                variant="ghost"
                size="sm"
                className="text-xs text-stone-400"
              >
                ← Prev
              </Button>
              <span className="px-2 text-xs text-stone-400">
                Page {table.getState().pagination.pageIndex + 1} of{" "}
                {table.getPageCount() || 1}
              </span>
              <Button
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
                variant="ghost"
                size="sm"
                className="text-xs text-stone-400"
              >
                Next →
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
