interface HelpPanelProps {
  connected: boolean;
  port: number | null;
  status: "up" | "down" | "unknown";
}

function statusTone(status: "up" | "down" | "unknown"): string {
  if (status === "up") return "text-emerald-300";
  if (status === "down") return "text-rose-300";
  return "text-amber-300";
}

export default function HelpPanel({
  connected,
  port,
  status,
}: HelpPanelProps) {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <section className="app-panel p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold text-white">How Doberman Works</h2>
            <p className="mt-2 max-w-2xl text-sm text-stone-400">
              Doberman runs a local monitoring loop on your machine. It probes
              multiple internet targets, records latency and failures, detects
              outages, computes rolling statistics, and keeps a local history
              for charts, exports, and reports.
            </p>
          </div>
          <div className="rounded-2xl border border-stone-800 bg-stone-950/90 px-4 py-3 text-sm">
            <div className="text-stone-500">Current app state</div>
            <div className={`mt-1 font-medium ${connected ? "text-emerald-300" : "text-stone-300"}`}>
              {connected ? "Connected to local API" : "Waiting for local API"}
            </div>
            <div className={`mt-1 text-sm ${statusTone(status)}`}>
              Monitor status: {status}
            </div>
            <div className="mt-1 text-xs text-stone-500">
              API port: {port ?? "starting..."}
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="app-panel p-5">
          <h3 className="text-sm font-semibold text-stone-200">What the app is doing</h3>
          <div className="mt-4 space-y-3 text-sm text-stone-300">
            <div className="rounded-2xl border border-stone-800 bg-stone-950/60 p-3">
              <div className="font-medium text-white">1. Connectivity checks</div>
              <p className="mt-1 text-stone-400">
                Doberman pings your configured targets on a schedule. On macOS
                it may fall back to TCP probes on port 443 if raw ICMP is not
                usable.
              </p>
            </div>
            <div className="rounded-2xl border border-stone-800 bg-stone-950/60 p-3">
              <div className="font-medium text-white">2. Outage detection</div>
              <p className="mt-1 text-stone-400">
                If enough consecutive rounds fail, Doberman marks the
                connection down, starts an outage record, and clears it when the
                line recovers.
              </p>
            </div>
            <div className="rounded-2xl border border-stone-800 bg-stone-950/60 p-3">
              <div className="font-medium text-white">3. Live updates</div>
              <p className="mt-1 text-stone-400">
                The dashboard updates through the app&apos;s local embedded API
                and event stream, so charts and status badges refresh without
                manual reloads.
              </p>
            </div>
            <div className="rounded-2xl border border-stone-800 bg-stone-950/60 p-3">
              <div className="font-medium text-white">4. History and reports</div>
              <p className="mt-1 text-stone-400">
                Pings, outages, rolling stats, and speed tests are stored in a
                local database and then surfaced in the log, heatmap, and
                export views.
              </p>
            </div>
          </div>
        </section>

        <section className="app-panel p-5">
          <h3 className="text-sm font-semibold text-stone-200">How to use it</h3>
          <div className="mt-4 space-y-3 text-sm text-stone-300">
            <div className="rounded-2xl border border-stone-800 bg-stone-950/60 p-3">
              <div className="font-medium text-white">Start with Settings</div>
              <p className="mt-1 text-stone-400">
                Add at least two reliable targets, confirm the gateway IP if
                you want local-link visibility, and tune the ping interval and
                outage threshold.
              </p>
            </div>
            <div className="rounded-2xl border border-stone-800 bg-stone-950/60 p-3">
              <div className="font-medium text-white">Use the Dashboard for live state</div>
              <p className="mt-1 text-stone-400">
                The banner shows current status, the chart shows recent ping
                behavior, and the statistics cards summarize uptime, jitter,
                packet loss, and latency.
              </p>
            </div>
            <div className="rounded-2xl border border-stone-800 bg-stone-950/60 p-3">
              <div className="font-medium text-white">Run speed tests when needed</div>
              <p className="mt-1 text-stone-400">
                The Speed Tests tab runs manual tests and shows historical
                results. Scheduled tests are controlled from Settings.
              </p>
            </div>
            <div className="rounded-2xl border border-stone-800 bg-stone-950/60 p-3">
              <div className="font-medium text-white">Review history</div>
              <p className="mt-1 text-stone-400">
                Outage Log shows individual incidents, Heatmap shows when
                downtime clusters occur, and Reports exports CSV or HTML output
                for sharing.
              </p>
            </div>
          </div>
        </section>
      </div>

      <section className="app-panel p-5">
        <h3 className="text-sm font-semibold text-stone-200">Troubleshooting</h3>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-stone-800 bg-stone-950/60 p-3 text-sm text-stone-300">
            <div className="font-medium text-white">If it stays on Connecting</div>
            <p className="mt-1 text-stone-400">
              Wait a few seconds for the embedded API and ping loop to start.
              If it still does not connect, restart the app and check the Debug
              tab for API and SSE activity.
            </p>
          </div>
          <div className="rounded-2xl border border-stone-800 bg-stone-950/60 p-3 text-sm text-stone-300">
            <div className="font-medium text-white">If speed tests fail</div>
            <p className="mt-1 text-stone-400">
              Doberman expects either Ookla&apos;s `speedtest` binary or Python
              `speedtest-cli` to be installed on the machine.
            </p>
          </div>
          <div className="rounded-2xl border border-stone-800 bg-stone-950/60 p-3 text-sm text-stone-300">
            <div className="font-medium text-white">If outages seem too sensitive</div>
            <p className="mt-1 text-stone-400">
              Increase the outage threshold or ping interval in Settings so
              brief network noise does not create false incidents.
            </p>
          </div>
          <div className="rounded-2xl border border-stone-800 bg-stone-950/60 p-3 text-sm text-stone-300">
            <div className="font-medium text-white">If the window disappears</div>
            <p className="mt-1 text-stone-400">
              Closing the window hides Doberman to the tray instead of exiting
              the process. Reopen it from the tray menu.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
