import { invoke } from "@tauri-apps/api/core";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";

import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import {
  checkpoint,
  initLogger,
  logError,
  logEvent,
} from "./core/logger";
import { startStartupWatchdog } from "./core/startup-watchdog";

async function bootstrapFrontend(): Promise<void> {
  let context: { runId: string; channel?: "dev" | "prod" } = {
    runId: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
  };

  try {
    const startupContext = await invoke<{
      runId: string;
      channel: "dev" | "prod";
    }>("get_startup_context");
    context = startupContext;
  } catch (error) {
    // runId local permanece como fallback
    console.error(error);
  }

  initLogger(context);
  checkpoint("js.main.begin");
  logEvent("info", "webview.context", context);
  logEvent("info", "env.graphics", {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
  });

  const rootElement = document.getElementById("root");
  if (!rootElement) {
    throw new Error("Elemento #root não encontrado");
  }

  checkpoint("js.react.root_created");
  startStartupWatchdog();

  ReactDOM.createRoot(rootElement).render(
    <ErrorBoundary
      onError={(error, info) => {
        logError("react-error-boundary", error, {
          componentStack: info.componentStack,
        });
      }}
    >
      <App />
    </ErrorBoundary>,
  );

  checkpoint("js.react.render_committed");
}

window.addEventListener("error", (event) => {
  logError("window.error", event.error ?? event.message, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  logError("unhandledrejection", event.reason);
});

void bootstrapFrontend().catch((error) => {
  logError("js.main.failed", error);
});
