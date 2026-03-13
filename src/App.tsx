import { useState, useEffect } from "react";
import { getApiPort } from "./api";
import { useSSE } from "./hooks/useSSE";
import StatusBanner from "./components/StatusBanner";
import LiveChart from "./components/LiveChart";
import SpeedTestPanel from "./components/SpeedTestPanel";
import StatsPanel from "./components/StatsPanel";
import OutageTable from "./components/OutageTable";
import HeatmapView from "./components/HeatmapView";
import ReportExport from "./components/ReportExport";
import SettingsPanel from "./components/SettingsPanel";

type View = "dashboard" | "outages" | "speed-tests" | "heatmap" | "reports" | "settings";

const NAV_ITEMS: { id: View; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "outages", label: "Outage Log" },
  { id: "speed-tests", label: "Speed Tests" },
  { id: "heatmap", label: "Heatmap" },
  { id: "reports", label: "Reports" },
  { id: "settings", label: "Settings" },
];

function App() {
  const [view, setView] = useState<View>("dashboard");
  const [port, setPort] = useState<number | null>(null);

  useEffect(() => {
    getApiPort()
      .then(setPort)
      .catch((err) => {
        console.error("Failed to get API port:", err);
      });
  }, []);

  const sse = useSSE(port);

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      {/* Sidebar */}
      <nav className="flex w-56 flex-col gap-1 border-r border-gray-800 bg-gray-900 p-4">
        <h1 className="mb-6 text-xl font-bold tracking-tight">Doberman</h1>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => setView(item.id)}
            className={`rounded px-3 py-2 text-left text-sm transition-colors ${
              view === item.id
                ? "bg-gray-800 font-medium text-white"
                : "text-gray-400 hover:bg-gray-800/50 hover:text-gray-200"
            }`}
          >
            {item.label}
          </button>
        ))}
        <div className="mt-auto flex items-center gap-2 pt-4 text-xs text-gray-600">
          <div
            className={`h-1.5 w-1.5 rounded-full ${sse.connected ? "bg-green-500" : "bg-gray-600"}`}
          />
          {sse.connected ? "Connected" : "Disconnected"}
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-6">
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
      </main>
    </div>
  );
}

export default App;
