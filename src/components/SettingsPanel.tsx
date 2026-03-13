import { useState, useEffect, useCallback } from "react";
import { fetchConfig, updateConfig, Config } from "../api";

interface Props {
  port: number | null;
}

// Validate IPv4, IPv6, or hostname
function isValidTarget(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) {
    return trimmed.split(".").every((n) => {
      const num = parseInt(n, 10);
      return num >= 0 && num <= 255;
    });
  }
  // IPv6 (simplified check)
  if (/^[0-9a-fA-F:]+$/.test(trimmed) && trimmed.includes(":")) return true;
  // Hostname
  if (/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(trimmed)) return true;
  return false;
}

export default function SettingsPanel({ port }: Props) {
  const [_config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Form state
  const [targets, setTargets] = useState<string[]>([]);
  const [gatewayIp, setGatewayIp] = useState("");
  const [pingInterval, setPingInterval] = useState(30);
  const [outageThreshold, setOutageThreshold] = useState(3);
  const [speedTestCooldown, setSpeedTestCooldown] = useState(180);
  const [speedTestScheduleHours, setSpeedTestScheduleHours] = useState(6);
  const [autoSpeedTestOnRecovery, setAutoSpeedTestOnRecovery] = useState(true);
  const [advertisedDown, setAdvertisedDown] = useState("");
  const [advertisedUp, setAdvertisedUp] = useState("");
  const [dataRetention, setDataRetention] = useState(90);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  const loadConfig = useCallback(async () => {
    if (!port) return;
    try {
      const cfg = await fetchConfig(port);
      setConfig(cfg);
      const parsedTargets: string[] = JSON.parse(cfg.targets);
      setTargets(parsedTargets);
      setGatewayIp(cfg.gateway_ip ?? "");
      setPingInterval(cfg.ping_interval_s);
      setOutageThreshold(cfg.outage_threshold);
      setSpeedTestCooldown(cfg.speed_test_cooldown_s);
      setSpeedTestScheduleHours(Math.round(cfg.speed_test_schedule_s / 3600));
      setAutoSpeedTestOnRecovery(cfg.auto_speed_test_on_recovery);
      setAdvertisedDown(cfg.advertised_download_mbps?.toString() ?? "");
      setAdvertisedUp(cfg.advertised_upload_mbps?.toString() ?? "");
      setDataRetention(cfg.data_retention_days);
    } catch (e) {
      setMessage({ type: "error", text: "Failed to load configuration" });
    } finally {
      setLoading(false);
    }
  }, [port]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleSave = async () => {
    if (!port) return;

    // Validate targets
    const validTargets = targets.filter((t) => t.trim());
    if (validTargets.length < 2) {
      setMessage({ type: "error", text: "At least 2 ping targets required" });
      return;
    }
    const invalidTarget = validTargets.find((t) => !isValidTarget(t));
    if (invalidTarget) {
      setMessage({ type: "error", text: `Invalid target: "${invalidTarget}"` });
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      const update: Partial<Config> = {
        targets: JSON.stringify(validTargets),
        gateway_ip: gatewayIp.trim() || null,
        ping_interval_s: Math.max(10, Math.min(300, pingInterval)),
        outage_threshold: Math.max(2, Math.min(10, outageThreshold)),
        speed_test_cooldown_s: Math.max(60, speedTestCooldown),
        speed_test_schedule_s: speedTestScheduleHours * 3600,
        auto_speed_test_on_recovery: autoSpeedTestOnRecovery,
        data_retention_days: Math.max(7, Math.min(365, dataRetention)),
        advertised_download_mbps: advertisedDown ? parseFloat(advertisedDown) : null,
        advertised_upload_mbps: advertisedUp ? parseFloat(advertisedUp) : null,
      };

      const updated = await updateConfig(port, update);
      setConfig(updated);
      setMessage({ type: "success", text: "Settings saved" });
    } catch {
      setMessage({ type: "error", text: "Failed to save settings" });
    } finally {
      setSaving(false);
    }
  };

  const addTarget = () => setTargets([...targets, ""]);
  const removeTarget = (i: number) => {
    if (targets.length <= 2) return;
    setTargets(targets.filter((_, idx) => idx !== i));
  };
  const updateTarget = (i: number, value: string) => {
    const next = [...targets];
    next[i] = value;
    setTargets(next);
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-gray-500">
        Loading settings...
      </div>
    );
  }

  const inputClass =
    "w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-blue-500 focus:outline-none";
  const labelClass = "block text-sm font-medium text-gray-300 mb-1";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Message toast */}
      {message && (
        <div
          className={`rounded px-4 py-2 text-sm ${
            message.type === "success"
              ? "bg-green-900/50 text-green-300 border border-green-800"
              : "bg-red-900/50 text-red-300 border border-red-800"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Ping Targets */}
      <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-200">Ping Targets</h3>
        <div className="space-y-2">
          {targets.map((t, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="text"
                value={t}
                onChange={(e) => updateTarget(i, e.target.value)}
                placeholder="e.g. 8.8.8.8 or dns.google"
                className={inputClass}
              />
              <button
                onClick={() => removeTarget(i)}
                disabled={targets.length <= 2}
                className="shrink-0 rounded border border-gray-700 px-2 text-sm text-gray-400 hover:text-red-400 disabled:opacity-30"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={addTarget}
          className="mt-2 rounded border border-gray-700 px-3 py-1 text-sm text-gray-300 hover:bg-gray-800"
        >
          + Add Target
        </button>
      </section>

      {/* Gateway */}
      <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-200">Gateway</h3>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className={labelClass}>Gateway IP</label>
            <input
              type="text"
              value={gatewayIp}
              onChange={(e) => setGatewayIp(e.target.value)}
              placeholder="e.g. 192.168.1.1"
              className={inputClass}
            />
          </div>
          <button
            onClick={() => setGatewayIp("")}
            className="mt-6 shrink-0 rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
          >
            Auto-detect
          </button>
        </div>
      </section>

      {/* Monitoring */}
      <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-200">Monitoring</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Ping interval (seconds)</label>
            <input
              type="number"
              min={10}
              max={300}
              value={pingInterval}
              onChange={(e) => setPingInterval(parseInt(e.target.value) || 30)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Outage threshold (rounds)</label>
            <input
              type="number"
              min={2}
              max={10}
              value={outageThreshold}
              onChange={(e) => setOutageThreshold(parseInt(e.target.value) || 3)}
              className={inputClass}
            />
          </div>
        </div>
      </section>

      {/* Speed Tests */}
      <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-200">Speed Tests</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Cooldown (seconds)</label>
            <input
              type="number"
              min={60}
              value={speedTestCooldown}
              onChange={(e) => setSpeedTestCooldown(parseInt(e.target.value) || 180)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Schedule (hours, 0=disabled)</label>
            <input
              type="number"
              min={0}
              max={24}
              value={speedTestScheduleHours}
              onChange={(e) => setSpeedTestScheduleHours(parseInt(e.target.value) || 0)}
              className={inputClass}
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={() => setAutoSpeedTestOnRecovery(!autoSpeedTestOnRecovery)}
            className={`relative h-6 w-11 rounded-full transition-colors ${
              autoSpeedTestOnRecovery ? "bg-blue-600" : "bg-gray-600"
            }`}
          >
            <span
              className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                autoSpeedTestOnRecovery ? "translate-x-5" : ""
              }`}
            />
          </button>
          <span className="text-sm text-gray-300">Auto speed test on recovery</span>
        </div>
      </section>

      {/* Advertised Speeds */}
      <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-200">Advertised Speeds</h3>
        <p className="mb-3 text-xs text-gray-500">
          Your ISP-advertised speeds, used for comparison in reports
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Download (Mbps)</label>
            <input
              type="number"
              min={0}
              step="any"
              value={advertisedDown}
              onChange={(e) => setAdvertisedDown(e.target.value)}
              placeholder="Optional"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Upload (Mbps)</label>
            <input
              type="number"
              min={0}
              step="any"
              value={advertisedUp}
              onChange={(e) => setAdvertisedUp(e.target.value)}
              placeholder="Optional"
              className={inputClass}
            />
          </div>
        </div>
      </section>

      {/* Data & Appearance */}
      <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-200">Data & Appearance</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Data retention (days)</label>
            <input
              type="number"
              min={7}
              max={365}
              value={dataRetention}
              onChange={(e) => setDataRetention(parseInt(e.target.value) || 90)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Theme</label>
            <div className="flex gap-2">
              <button
                onClick={() => setTheme("dark")}
                className={`flex-1 rounded border px-3 py-2 text-sm transition-colors ${
                  theme === "dark"
                    ? "border-blue-500 bg-blue-900/30 text-blue-300"
                    : "border-gray-700 text-gray-400 hover:bg-gray-800"
                }`}
              >
                Dark
              </button>
              <button
                onClick={() => setTheme("light")}
                className={`flex-1 rounded border px-3 py-2 text-sm transition-colors ${
                  theme === "light"
                    ? "border-blue-500 bg-blue-900/30 text-blue-300"
                    : "border-gray-700 text-gray-400 hover:bg-gray-800"
                }`}
              >
                Light
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Save */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
