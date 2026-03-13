import { invoke } from "@tauri-apps/api/core";

let cachedPort: number | null = null;

export async function getApiPort(): Promise<number> {
  if (cachedPort !== null) return cachedPort;
  cachedPort = await invoke<number>("get_api_port");
  return cachedPort;
}

function baseUrl(port: number): string {
  return `http://localhost:${port}`;
}

export interface PingRecord {
  id: number;
  timestamp: string;
  target: string;
  success: boolean;
  latency_ms: number | null;
  dns_ms: number | null;
  error: string | null;
}

export interface Outage {
  id: number;
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
  cause: string;
  targets_down: string;
  traceroute: string | null;
}

export interface StatusResponse {
  status: "up" | "down";
  active_outage: {
    id: number;
    started_at: string;
    cause: string;
    targets_down: string[];
    duration_s: number;
  } | null;
  last_pings: PingRecord[];
  icmp_mode: "icmp" | "tcp";
}

export interface PingParams {
  from?: string;
  to?: string;
  target?: string;
  limit?: number;
}

export interface OutageParams {
  from?: string;
  to?: string;
  cause?: string;
  limit?: number;
}

export interface Config {
  id: number;
  targets: string;
  gateway_ip: string | null;
  ping_interval_s: number;
  outage_threshold: number;
  speed_test_cooldown_s: number;
  speed_test_schedule_s: number;
  auto_speed_test_on_recovery: boolean;
  data_retention_days: number;
  advertised_download_mbps: number | null;
  advertised_upload_mbps: number | null;
}

export interface RollingStats {
  id: number;
  timestamp: string;
  window_s: number;
  packet_loss_pct: number;
  jitter_ms: number;
  latency_p50: number;
  latency_p95: number;
  latency_p99: number;
  avg_latency_ms: number;
}

export interface SpeedTestResult {
  id: number;
  timestamp: string;
  download_mbps: number;
  upload_mbps: number;
  ping_ms: number;
  server_name: string;
  trigger: string;
}

export interface StatsSummary {
  uptime_1h: number;
  uptime_24h: number;
  uptime_7d: number;
  mtbf_s: number | null;
  mttr_s: number | null;
  outage_count_today: number;
  jitter_ms: number;
  packet_loss_pct: number;
  latency_p95: number;
}

function buildQuery(params: object): string {
  const entries = Object.entries(params).filter(
    (e): e is [string, string | number] => e[1] !== undefined,
  );
  if (entries.length === 0) return "";
  return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

export async function fetchStatus(port: number): Promise<StatusResponse> {
  const res = await fetch(`${baseUrl(port)}/api/status`);
  return res.json();
}

export async function fetchPings(
  port: number,
  params?: PingParams,
): Promise<{ pings: PingRecord[]; total: number }> {
  const q = buildQuery(params ?? {});
  const res = await fetch(`${baseUrl(port)}/api/pings${q}`);
  return res.json();
}

export async function fetchOutages(
  port: number,
  params?: OutageParams,
): Promise<{ outages: Outage[] }> {
  const q = buildQuery(params ?? {});
  const res = await fetch(`${baseUrl(port)}/api/outages${q}`);
  return res.json();
}

export async function fetchStats(
  port: number,
  window?: number,
): Promise<RollingStats[]> {
  const q = window !== undefined ? `?window=${window}` : "";
  const res = await fetch(`${baseUrl(port)}/api/stats${q}`);
  return res.json();
}

export async function fetchStatsSummary(port: number): Promise<RollingStats> {
  const res = await fetch(`${baseUrl(port)}/api/stats/summary`);
  return res.json();
}

export async function fetchConfig(port: number): Promise<Config> {
  const res = await fetch(`${baseUrl(port)}/api/config`);
  return res.json();
}

export async function updateConfig(
  port: number,
  config: Partial<Config>,
): Promise<Config> {
  const res = await fetch(`${baseUrl(port)}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  return res.json();
}

export async function fetchSpeedTests(
  port: number,
): Promise<{ tests: SpeedTestResult[] }> {
  const res = await fetch(`${baseUrl(port)}/api/speed-tests`);
  return res.json();
}

export async function triggerSpeedTest(
  port: number,
): Promise<SpeedTestResult> {
  const res = await fetch(`${baseUrl(port)}/api/speed-tests/run`, {
    method: "POST",
  });
  return res.json();
}

export async function fetchStatsSummaryFull(
  port: number,
): Promise<StatsSummary> {
  const res = await fetch(`${baseUrl(port)}/api/stats/summary`);
  return res.json();
}

export interface HeatmapCell {
  date: string;
  hour: number;
  outage_count: number;
  downtime_minutes: number;
}

export async function fetchHeatmap(
  port: number,
  days: number,
): Promise<{ cells: HeatmapCell[] }> {
  const res = await fetch(`${baseUrl(port)}/api/heatmap?days=${days}`);
  return res.json();
}

export async function exportCsv(
  port: number,
  from: string,
  to: string,
): Promise<void> {
  const q = buildQuery({ from, to });
  const res = await fetch(`${baseUrl(port)}/api/export/csv${q}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `doberman-outages-${from}-to-${to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function exportReport(
  port: number,
  from: string,
  to: string,
): Promise<void> {
  const q = buildQuery({ from, to });
  const res = await fetch(`${baseUrl(port)}/api/export/report${q}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `doberman-report-${from}-to-${to}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
