import { useState, useEffect, useCallback } from "react";
import { fetchConfig, updateConfig, sendTestNotification, Config } from "../api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

interface Props {
  port: number | null;
}

interface TargetEntry {
  id: string;
  value: string;
}

function createTargetEntry(value = ""): TargetEntry {
  return {
    id: crypto.randomUUID(),
    value,
  };
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
  const [targets, setTargets] = useState<TargetEntry[]>([]);
  const [gatewayIp, setGatewayIp] = useState("");
  const [pingInterval, setPingInterval] = useState(30);
  const [outageThreshold, setOutageThreshold] = useState(3);
  const [notifyOnOutage, setNotifyOnOutage] = useState(true);
  const [notifyOnRecovery, setNotifyOnRecovery] = useState(true);
  const [speedTestCooldown, setSpeedTestCooldown] = useState(180);
  const [speedTestScheduleHours, setSpeedTestScheduleHours] = useState(6);
  const [autoSpeedTestOnRecovery, setAutoSpeedTestOnRecovery] = useState(true);
  const [advertisedDown, setAdvertisedDown] = useState("");
  const [advertisedUp, setAdvertisedUp] = useState("");
  const [dataRetention, setDataRetention] = useState(90);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [sendingTestNotification, setSendingTestNotification] = useState(false);

  const loadConfig = useCallback(async () => {
    if (!port) return;
    try {
      const cfg = await fetchConfig(port);
      setConfig(cfg);
      const parsedTargets: string[] = JSON.parse(cfg.targets);
      setTargets(parsedTargets.map((target) => createTargetEntry(target)));
      setGatewayIp(cfg.gateway_ip ?? "");
      setPingInterval(cfg.ping_interval_s);
      setOutageThreshold(cfg.outage_threshold);
      setNotifyOnOutage(cfg.notify_on_outage);
      setNotifyOnRecovery(cfg.notify_on_recovery);
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
    const validTargets = targets
      .map((target) => target.value.trim())
      .filter(Boolean);
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
        notify_on_outage: notifyOnOutage,
        notify_on_recovery: notifyOnRecovery,
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

  const addTarget = () => setTargets([...targets, createTargetEntry()]);
  const removeTarget = (id: string) => {
    if (targets.length <= 2) return;
    setTargets(targets.filter((target) => target.id !== id));
  };
  const updateTarget = (id: string, value: string) => {
    setTargets((current) =>
      current.map((target) =>
        target.id === id ? { ...target, value } : target,
      ),
    );
  };

  const handleTestNotification = async () => {
    setSendingTestNotification(true);
    setMessage(null);

    try {
      const logPath = await sendTestNotification();
      setMessage({
        type: "success",
        text: `Test notification queued. Log: ${logPath}`,
      });
    } catch {
      setMessage({ type: "error", text: "Failed to send test notification" });
    } finally {
      setSendingTestNotification(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-stone-500">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Message toast */}
      {message && (
        <div
          className={`rounded-2xl px-4 py-2 text-sm ${
            message.type === "success"
              ? "border border-emerald-900 bg-emerald-950/50 text-emerald-200"
              : "border border-rose-900 bg-rose-950/50 text-rose-200"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Ping Targets */}
      <section className="app-panel p-5">
        <h3 className="mb-3 text-sm font-semibold text-stone-200">Ping Targets</h3>
        <div className="space-y-2">
          {targets.map((target, i) => (
            <div key={target.id} className="flex gap-2">
              <Input
                id={`target-${i}`}
                type="text"
                value={target.value}
                onChange={(e) => updateTarget(target.id, e.target.value)}
                placeholder="e.g. 8.8.8.8 or dns.google"
                className="h-10"
              />
              <Button
                onClick={() => removeTarget(target.id)}
                disabled={targets.length <= 2}
                variant="secondary"
                className="shrink-0 text-stone-400 hover:text-rose-300"
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
        <Button
          onClick={addTarget}
          variant="secondary"
          size="sm"
          className="mt-2"
        >
          + Add Target
        </Button>
      </section>

      {/* Gateway */}
      <section className="app-panel p-5">
        <h3 className="mb-3 text-sm font-semibold text-stone-200">Gateway</h3>
        <div className="flex gap-2">
          <div className="flex-1">
            <Label htmlFor="gateway-ip" className="mb-2">Gateway IP</Label>
            <Input
              id="gateway-ip"
              type="text"
              value={gatewayIp}
              onChange={(e) => setGatewayIp(e.target.value)}
              placeholder="e.g. 192.168.1.1"
              className="h-10"
            />
          </div>
          <Button
            onClick={() => setGatewayIp("")}
            variant="secondary"
            className="mt-7 shrink-0"
          >
            Auto-detect
          </Button>
        </div>
      </section>

      {/* Monitoring */}
      <section className="app-panel p-5">
        <h3 className="mb-3 text-sm font-semibold text-stone-200">Monitoring</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="ping-interval" className="mb-2">Ping interval (seconds)</Label>
            <Input
              id="ping-interval"
              type="number"
              min={10}
              max={300}
              value={pingInterval}
              onChange={(e) => setPingInterval(parseInt(e.target.value) || 30)}
              className="h-10"
            />
          </div>
          <div>
            <Label htmlFor="outage-threshold" className="mb-2">Outage threshold (rounds)</Label>
            <Input
              id="outage-threshold"
              type="number"
              min={2}
              max={10}
              value={outageThreshold}
              onChange={(e) => setOutageThreshold(parseInt(e.target.value) || 3)}
              className="h-10"
            />
          </div>
        </div>
      </section>

      {/* Notifications */}
      <section className="app-panel p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="mb-1 text-sm font-semibold text-stone-200">Notifications</h3>
            <p className="text-xs text-stone-500">
              Control outage alerts now, then validate bundled behavior on macOS and Windows later.
            </p>
          </div>
          <Button
            onClick={handleTestNotification}
            variant="secondary"
            disabled={sendingTestNotification}
          >
            {sendingTestNotification ? "Sending..." : "Send Test Notification"}
          </Button>
        </div>
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-stone-800 bg-stone-950/70 px-4 py-3">
            <div>
              <Label htmlFor="notify-on-outage">Outage detected</Label>
              <p className="mt-1 text-xs text-stone-500">
                Send a desktop alert when Doberman transitions from up to down.
              </p>
            </div>
            <Switch
              id="notify-on-outage"
              checked={notifyOnOutage}
              onCheckedChange={setNotifyOnOutage}
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-stone-800 bg-stone-950/70 px-4 py-3">
            <div>
              <Label htmlFor="notify-on-recovery">Connection restored</Label>
              <p className="mt-1 text-xs text-stone-500">
                Send a desktop alert when the outage ends and connectivity returns.
              </p>
            </div>
            <Switch
              id="notify-on-recovery"
              checked={notifyOnRecovery}
              onCheckedChange={setNotifyOnRecovery}
            />
          </div>
        </div>
      </section>

      {/* Speed Tests */}
      <section className="app-panel p-5">
        <h3 className="mb-3 text-sm font-semibold text-stone-200">Speed Tests</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="speed-test-cooldown" className="mb-2">Cooldown (seconds)</Label>
            <Input
              id="speed-test-cooldown"
              type="number"
              min={60}
              value={speedTestCooldown}
              onChange={(e) => setSpeedTestCooldown(parseInt(e.target.value) || 180)}
              className="h-10"
            />
          </div>
          <div>
            <Label htmlFor="speed-test-schedule" className="mb-2">Schedule (hours, 0=disabled)</Label>
            <Input
              id="speed-test-schedule"
              type="number"
              min={0}
              max={24}
              value={speedTestScheduleHours}
              onChange={(e) => setSpeedTestScheduleHours(parseInt(e.target.value) || 0)}
              className="h-10"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Switch
            id="auto-speed-test-on-recovery"
            checked={autoSpeedTestOnRecovery}
            onCheckedChange={setAutoSpeedTestOnRecovery}
          />
          <Label htmlFor="auto-speed-test-on-recovery">Auto speed test on recovery</Label>
        </div>
      </section>

      {/* Advertised Speeds */}
      <section className="app-panel p-5">
        <h3 className="mb-3 text-sm font-semibold text-stone-200">Advertised Speeds</h3>
        <p className="mb-3 text-xs text-stone-500">
          Your ISP-advertised speeds, used for comparison in reports
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="advertised-download" className="mb-2">Download (Mbps)</Label>
            <Input
              id="advertised-download"
              type="number"
              min={0}
              step="any"
              value={advertisedDown}
              onChange={(e) => setAdvertisedDown(e.target.value)}
              placeholder="Optional"
              className="h-10"
            />
          </div>
          <div>
            <Label htmlFor="advertised-upload" className="mb-2">Upload (Mbps)</Label>
            <Input
              id="advertised-upload"
              type="number"
              min={0}
              step="any"
              value={advertisedUp}
              onChange={(e) => setAdvertisedUp(e.target.value)}
              placeholder="Optional"
              className="h-10"
            />
          </div>
        </div>
      </section>

      {/* Data & Appearance */}
      <section className="app-panel p-5">
        <h3 className="mb-3 text-sm font-semibold text-stone-200">Data & Appearance</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="data-retention" className="mb-2">Data retention (days)</Label>
            <Input
              id="data-retention"
              type="number"
              min={7}
              max={365}
              value={dataRetention}
              onChange={(e) => setDataRetention(parseInt(e.target.value) || 90)}
              className="h-10"
            />
          </div>
          <div>
            <Label htmlFor="theme-select" className="mb-2">Theme</Label>
            <Select value={theme} onValueChange={(value: "dark" | "light") => setTheme(value)}>
              <SelectTrigger id="theme-select">
                <SelectValue placeholder="Select theme" />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      {/* Save */}
      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          disabled={saving}
          className="px-6"
        >
          {saving ? "Saving..." : "Save Settings"}
        </Button>
      </div>
    </div>
  );
}
