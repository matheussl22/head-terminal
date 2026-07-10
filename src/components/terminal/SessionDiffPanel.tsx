import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

interface SessionDiffPanelProps {
  cwd: string;
  onClose: () => void;
}

export function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "session-diff__line session-diff__line--file";
  }
  if (line.startsWith("+")) {
    return "session-diff__line session-diff__line--add";
  }
  if (line.startsWith("-")) {
    return "session-diff__line session-diff__line--del";
  }
  if (line.startsWith("@@") || line.startsWith("??")) {
    return "session-diff__line session-diff__line--meta";
  }
  return "session-diff__line";
}

export function SessionDiffPanel({ cwd, onClose }: SessionDiffPanelProps) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void invoke<string>("get_session_diff", { cwd })
      .then(setDiff)
      .catch((cause) => setError(String(cause)));
  }, [cwd]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="create-session-backdrop" onClick={onClose}>
      <div
        className="create-session-dialog session-diff"
        role="dialog"
        aria-label="Diff da sessão"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="create-session-dialog__title">Mudanças da sessão</h2>

        <div className="session-diff__body">
          {error && <span className="create-session-dialog__error">{error}</span>}
          {diff === "" && <span>Nenhuma mudança em relação ao HEAD.</span>}
          {diff && (
            <pre>
              {diff.split("\n").map((line, index) => (
                <span key={index} className={diffLineClass(line)}>
                  {line}
                  {"\n"}
                </span>
              ))}
            </pre>
          )}
        </div>

        <div className="create-session-dialog__actions">
          <button
            type="button"
            className="agent-toolbar__button"
            onClick={onClose}
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
