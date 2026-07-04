import { invoke } from "@tauri-apps/api/core";
import { open as openDirectoryPicker } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";

import { buildAgentProfiles } from "../../config/agents";
import { loadRecentCwds, noteRecentCwd } from "../../core/ui-preferences";

interface CreateSessionDialogProps {
  open: boolean;
  defaultCwd: string;
  onClose: () => void;
  onCreate: (cwd: string, agentProfileId: string) => void;
}

interface AgentCliStatus {
  cursor: boolean;
  claude: boolean;
  codex: boolean;
}

export function CreateSessionDialog({
  open,
  defaultCwd,
  onClose,
  onCreate,
}: CreateSessionDialogProps) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [agentProfileId, setAgentProfileId] = useState("cursor");
  const [cwdError, setCwdError] = useState<string | null>(null);
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [cliStatus, setCliStatus] = useState<AgentCliStatus | null>(null);

  useEffect(() => {
    if (open) {
      setCwd(defaultCwd);
      setCwdError(null);
      setRecentCwds(loadRecentCwds());
      void invoke<AgentCliStatus>("check_agent_clis")
        .then(setCliStatus)
        .catch(() =>
          setCliStatus({ cursor: true, claude: true, codex: true }),
        );
    }
  }, [defaultCwd, open]);

  if (!open) {
    return null;
  }

  const profiles = Object.values(buildAgentProfiles());

  const isAgentAvailable = (id: string): boolean => {
    if (!cliStatus || id === "shell") {
      return true;
    }
    return cliStatus[id as keyof AgentCliStatus] ?? true;
  };

  const validateAndCreate = async () => {
    const nextCwd = cwd.trim() || defaultCwd;
    const exists = await invoke<boolean>("path_exists", { path: nextCwd });
    if (!exists) {
      setCwdError("Diretório não encontrado");
      return;
    }
    noteRecentCwd(nextCwd);
    onCreate(nextCwd, agentProfileId);
    onClose();
  };

  const browseDirectory = async () => {
    const selected = await openDirectoryPicker({
      directory: true,
      multiple: false,
      defaultPath: cwd || defaultCwd,
    });
    if (typeof selected === "string") {
      setCwd(selected);
      setCwdError(null);
    }
  };

  return (
    <div className="create-session-backdrop" onClick={onClose}>
      <div
        className="create-session-dialog"
        role="dialog"
        aria-label="Nova sessão"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="create-session-dialog__title">Nova sessão</h2>

        <label className="create-session-dialog__field">
          <span>Diretório</span>
          <div className="create-session-dialog__cwd-row">
            <input
              type="text"
              value={cwd}
              onChange={(event) => {
                setCwd(event.target.value);
                setCwdError(null);
              }}
              placeholder="/home/user/projeto"
            />
            <button
              type="button"
              className="agent-toolbar__button--ghost"
              onClick={() => void browseDirectory()}
            >
              Procurar…
            </button>
          </div>
          {cwdError && (
            <span className="create-session-dialog__error">{cwdError}</span>
          )}
        </label>

        {recentCwds.length > 0 && (
          <div className="create-session-dialog__recent">
            {recentCwds.map((item) => (
              <button
                key={item}
                type="button"
                className="create-session-dialog__chip"
                onClick={() => {
                  setCwd(item);
                  setCwdError(null);
                }}
              >
                {item.split("/").pop() ?? item}
              </button>
            ))}
          </div>
        )}

        <label className="create-session-dialog__field">
          <span>Agent</span>
          <select
            value={agentProfileId}
            onChange={(event) => setAgentProfileId(event.target.value)}
          >
            {profiles.map((profile) => (
              <option
                key={profile.id}
                value={profile.id}
                disabled={!isAgentAvailable(profile.id)}
              >
                {profile.label}
                {!isAgentAvailable(profile.id) ? " — não instalada" : ""}
              </option>
            ))}
          </select>
        </label>

        <div className="create-session-dialog__actions">
          <button type="button" className="agent-toolbar__button--ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="agent-toolbar__button"
            onClick={() => void validateAndCreate()}
          >
            Criar
          </button>
        </div>
      </div>
    </div>
  );
}
