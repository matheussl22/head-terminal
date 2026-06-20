import { invoke } from "@tauri-apps/api/core";

import { getFrontendDiagnosticBundle, getRunId, logEvent } from "./logger";

export async function copyDiagnosticToClipboard(): Promise<void> {
  const bundle = {
    frontend: getFrontendDiagnosticBundle(),
    exportedAt: new Date().toISOString(),
  };
  await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
  logEvent("info", "diagnostic.copied", { runId: getRunId() });
}

export async function exportDiagnosticBundle(): Promise<string> {
  const path = await invoke<string>("export_diagnostic_bundle", {
    frontend: getFrontendDiagnosticBundle(),
  });
  logEvent("info", "diagnostic.exported", { path, runId: getRunId() });
  return path;
}
