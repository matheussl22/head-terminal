import { invoke } from "@tauri-apps/api/core";
import { open as openDirectoryPicker } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";

import { buildAgentProfiles } from "../../config/agents";
import { loadRecentCwds, noteRecentCwd } from "../../core/ui-preferences";
import type { GitContext } from "../../types/git-context";

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
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const target = cwd.trim() || defaultCwd;
    const timer = window.setTimeout(() => {
      void invoke<Pick<GitContext, "repoRoot">>("get_git_context", {
        cwd: target,
      })
        .then((context) => setIsGitRepo(Boolean(context.repoRoot)))
        .catch(() => setIsGitRepo(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [cwd, defaultCwd, open]);

  useEffect(() => {
    if (open) {
      setCwd(defaultCwd);
      setCwdError(null);
      setUseWorktree(false);
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

    let sessionCwd = nextCwd;
    if (isGitRepo && useWorktree) {
      try {
        sessionCwd = await invoke<string>("create_session_worktree", {
          cwd: nextCwd,
        });
      } catch (error) {
        setCwdError(`Falha ao criar worktree: ${String(error)}`);
        return;
      }
    }

    noteRecentCwd(nextCwd);
    onCreate(sessionCwd, agentProfileId);
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

        {isGitRepo && (
          <label className="create-session-dialog__field create-session-dialog__worktree">
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(event) => setUseWorktree(event.target.checked)}
            />
            <span>
              Worktree isolado — cria branch <code>agent-N</code> em pasta
              irmã para agents em paralelo
            </span>
          </label>
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
