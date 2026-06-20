import { useEffect, useState } from "react";

import {
  copyDiagnosticToClipboard,
  exportDiagnosticBundle,
} from "../core/export-diagnostic";
import { getLastCheckpoint, getRunId } from "../core/logger";
import { humanizeCheckpoint } from "../core/startup-labels";

interface BootScreenProps {
  error?: string | null;
  slow?: boolean;
  showDiagnosticActions?: boolean;
}

export function BootScreen({
  error,
  slow = false,
  showDiagnosticActions = false,
}: BootScreenProps) {
  const [stageLabel, setStageLabel] = useState("Iniciando sessões…");
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [copyDone, setCopyDone] = useState(false);

  useEffect(() => {
    const update = () => {
      setStageLabel(humanizeCheckpoint(getLastCheckpoint()?.stage ?? null));
    };
    update();
    const id = window.setInterval(update, 500);
    return () => window.clearInterval(id);
  }, []);

  const runId = getRunId();
  const shortRunId = runId ? runId.slice(-6) : "…";

  return (
    <div className="boot-screen">
      <div className="boot-screen__content">
        <span className="boot-screen__logo" aria-hidden>
          ●
        </span>
        <h1 className="boot-screen__title">Head Terminal</h1>
        <p
          className={
            error
              ? "boot-screen__subtitle boot-screen__subtitle--error"
              : "boot-screen__subtitle"
          }
        >
          {error ?? (slow ? "A inicialização está demorando…" : stageLabel)}
        </p>
        <p className="boot-screen__meta">
          run: {shortRunId} · {import.meta.env.DEV ? "dev" : "prod"}
        </p>
        {!error && (
          <div className="boot-screen__progress" aria-hidden>
            <div className="boot-screen__progress-bar" />
          </div>
        )}
        {error && (
          <button
            type="button"
            className="boot-screen__retry"
            onClick={() => window.location.reload()}
          >
            Tentar novamente
          </button>
        )}
        {showDiagnosticActions && (
          <div className="boot-screen__actions">
            <button
              type="button"
              className="boot-screen__retry"
              onClick={() => {
                void copyDiagnosticToClipboard().then(() => setCopyDone(true));
              }}
            >
              {copyDone ? "Diagnóstico copiado" : "Copiar diagnóstico"}
            </button>
            <button
              type="button"
              className="boot-screen__retry"
              onClick={() => {
                void exportDiagnosticBundle().then((path) => setExportPath(path));
              }}
            >
              Exportar diagnóstico
            </button>
          </div>
        )}
        {exportPath && (
          <p className="boot-screen__export-path" title={exportPath}>
            Salvo em logs/
          </p>
        )}
      </div>
    </div>
  );
}
