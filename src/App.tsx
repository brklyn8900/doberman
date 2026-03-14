import { useState, useEffect, useRef } from "react";
import { getApiPort, waitForApi } from "./api";
import { useSSE } from "./hooks/useSSE";
import StatusBanner from "./components/StatusBanner";
import LiveChart from "./components/LiveChart";
import SpeedTestPanel from "./components/SpeedTestPanel";
import StatsPanel from "./components/StatsPanel";
import OutageTable from "./components/OutageTable";
import HeatmapView from "./components/HeatmapView";
import ReportExport from "./components/ReportExport";
import SettingsPanel from "./components/SettingsPanel";
import DebugPanel from "./components/DebugPanel";
import HelpPanel from "./components/HelpPanel";
import dobermanLogo from "../images/doberman-logo.png";

type View =
  | "dashboard"
  | "outages"
  | "speed-tests"
  | "heatmap"
  | "reports"
  | "settings"
  | "debug"
  | "help";

const NAV_ITEMS: { id: View; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "outages", label: "Outage Log" },
  { id: "speed-tests", label: "Speed Tests" },
  { id: "heatmap", label: "Heatmap" },
  { id: "reports", label: "Reports" },
  { id: "settings", label: "Settings" },
  { id: "debug", label: "Debug" },
  { id: "help", label: "Help" },
];

const PRIMARY_NAV: View[] = [
  "dashboard",
  "outages",
  "speed-tests",
  "heatmap",
  "reports",
];

const SECONDARY_NAV: View[] = ["settings", "help", "debug"];

function App() {
  const [view, setView] = useState<View>("dashboard");
  const [port, setPort] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    getApiPort()
      .then(async (apiPort) => {
        await waitForApi(apiPort);
        if (!cancelled) {
          setPort(apiPort);
        }
      })
      .catch((err) => {
        console.error("Failed to initialize API connection:", err);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const sse = useSSE(port);
  const connectedPill = sse.connected
    ? "bg-emerald-400"
    : "bg-stone-600";

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const navLabel = (id: View) =>
    NAV_ITEMS.find((item) => item.id === id)?.label ?? id;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border border-stone-800 bg-stone-950/90 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
              <img
                src={dobermanLogo}
                alt="Doberman logo"
                className="h-full w-full object-contain"
              />
            </div>

            <div>
              <div className="app-brand-kicker">Local Monitor</div>
              <h1 className="app-brand-title">Doberman</h1>
              <p className="app-brand-copy">
                Track connectivity, latency, outages, and recovery from one local dashboard.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-3 lg:items-end">
            <nav className="app-nav">
              {PRIMARY_NAV.map((id) => (
                <button
                  key={id}
                  onClick={() => {
                    setView(id);
                    setMenuOpen(false);
                  }}
                  className={`app-nav-button ${view === id ? "app-nav-button-active" : ""}`}
                >
                  {navLabel(id)}
                </button>
              ))}

              <div ref={menuRef} className="relative">
                <button
                  onClick={() => setMenuOpen((open) => !open)}
                  className={`app-nav-button ${SECONDARY_NAV.includes(view) ? "app-nav-button-active" : ""}`}
                >
                  More
                </button>

                {menuOpen && (
                  <div className="app-menu">
                    {SECONDARY_NAV.map((id) => (
                      <button
                        key={id}
                        onClick={() => {
                          setView(id);
                          setMenuOpen(false);
                        }}
                        className={`app-menu-item ${view === id ? "app-menu-item-active" : ""}`}
                      >
                        {navLabel(id)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </nav>

            <div className="flex flex-wrap gap-2">
              <div className="app-status-pill">
                <div className={`h-2 w-2 rounded-full ${connectedPill}`} />
                {sse.connected ? "Live connection" : "Starting local API"}
              </div>
              <div className="app-status-pill">
                Status: <span className="font-medium capitalize text-stone-100">{sse.status}</span>
              </div>
              <div className="app-status-pill">
                Port: <span className="font-medium text-stone-100">{port ?? "..."}</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
        {view === "dashboard" && (
          <div className="flex flex-col gap-4">
            <StatusBanner
              status={sse.status}
              lastPings={sse.lastPings}
              activeOutage={sse.activeOutage}
              connected={sse.connected}
            />
            <LiveChart
              pingHistory={sse.pingHistory}
              outageRanges={sse.outageRanges}
            />
            <StatsPanel port={port} statsUpdate={sse.statsUpdate} />
          </div>
        )}
        {view === "speed-tests" && (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">Speed Tests</h2>
            <SpeedTestPanel
              port={port}
              speedTestRunning={sse.speedTestRunning}
              lastSpeedTestResult={sse.lastSpeedTestResult}
            />
          </div>
        )}
        {view === "outages" && (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">Outage Log</h2>
            <OutageTable port={port} />
          </div>
        )}
        {view === "heatmap" && (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">Outage Heatmap</h2>
            <HeatmapView port={port} />
          </div>
        )}
        {view === "reports" && (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">Reports</h2>
            <ReportExport port={port} />
          </div>
        )}
        {view === "settings" && (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">Settings</h2>
            <SettingsPanel port={port} />
          </div>
        )}
        {view === "debug" && (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">Debug</h2>
            <DebugPanel port={port} sse={sse} />
          </div>
        )}
        {view === "help" && (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">Help</h2>
            <HelpPanel
              connected={sse.connected}
              port={port}
              status={sse.status}
            />
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
