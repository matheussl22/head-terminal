import { invoke } from "@tauri-apps/api/core";
import { open as openDirectoryPicker } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";

import { buildAgentProfiles } from "../../config/agents";
import {
  DEFAULT_CLAUDE_ACCOUNT_ID,
  loadClaudeAccountProfiles,
  type ClaudeAccountProfile,
} from "../../core/claude-accounts";
import {
  loadLastAgent,
  loadLastClaudeAccount,
  loadRecentCwds,
  noteRecentCwd,
  saveLastAgent,
  saveLastClaudeAccount,
} from "../../core/ui-preferences";
import type { GitContext } from "../../types/git-context";
import {
  IconAgentClaude,
  IconAgentCodex,
  IconAgentCursor,
  IconAgentShell,
  IconClose,
  IconPlus,
} from "../ui/Icons";

interface CreateSessionDialogProps {
  open: boolean;
  defaultCwd: string;
  onClose: () => void;
  onCreate: (
    cwd: string,
    agentProfileId: string,
    claudeAccountId?: string,
  ) => void;
}

interface AgentCliStatus {
  cursor: boolean;
  claude: boolean;
  codex: boolean;
}

let cliStatusCache: AgentCliStatus | null = null;

function AgentIcon({ id }: { id: string }) {
  if (id === "claude") return <IconAgentClaude size={18} />;
  if (id === "codex") return <IconAgentCodex size={18} />;
  if (id === "shell") return <IconAgentShell size={18} />;
  return <IconAgentCursor size={18} />;
}

export function CreateSessionDialog({
  open,
  defaultCwd,
  onClose,
  onCreate,
}: CreateSessionDialogProps) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [agentProfileId, setAgentProfileId] = useState("cursor");
  const [claudeAccountId, setClaudeAccountId] = useState(
    DEFAULT_CLAUDE_ACCOUNT_ID,
  );
  const [claudeAccounts, setClaudeAccounts] = useState<ClaudeAccountProfile[]>(
    [],
  );
  const [cwdError, setCwdError] = useState<string | null>(null);
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [cliStatus, setCliStatus] = useState<AgentCliStatus | null>(null);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

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
      const accounts = loadClaudeAccountProfiles();
      const lastAgent = loadLastAgent();
      const lastAccount = loadLastClaudeAccount();
      setCwd(defaultCwd);
      setCwdError(null);
      setUseWorktree(false);
      setCreating(false);
      setClaudeAccounts(accounts);
      setAgentProfileId(
        ["cursor", "claude", "codex", "shell"].includes(lastAgent)
          ? lastAgent
          : "cursor",
      );
      setClaudeAccountId(
        accounts.some((account) => account.id === lastAccount)
          ? lastAccount
          : DEFAULT_CLAUDE_ACCOUNT_ID,
      );
      setRecentCwds(loadRecentCwds());
      if (cliStatusCache) {
        setCliStatus(cliStatusCache);
      } else {
        void invoke<AgentCliStatus>("check_agent_clis")
          .then((status) => {
            cliStatusCache = status;
            setCliStatus(status);
            if (
              lastAgent !== "shell" &&
              !status[lastAgent as keyof AgentCliStatus]
            ) {
              setAgentProfileId(status.cursor ? "cursor" : "shell");
            }
          })
          .catch(() =>
            setCliStatus({ cursor: true, claude: true, codex: true }),
          );
      }
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
    if (creating) {
      return;
    }
    setCreating(true);
    const nextCwd = cwd.trim() || defaultCwd;
    let exists = false;
    try {
      exists = await invoke<boolean>("path_exists", { path: nextCwd });
    } catch {
      setCwdError("Não foi possível acessar o diretório");
      setCreating(false);
      return;
    }
    if (!exists) {
      setCwdError("Diretório não encontrado");
      setCreating(false);
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
        setCreating(false);
        return;
      }
    }

    noteRecentCwd(nextCwd);
    saveLastAgent(agentProfileId);
    if (agentProfileId === "claude") {
      saveLastClaudeAccount(claudeAccountId);
    }
    onCreate(
      sessionCwd,
      agentProfileId,
      agentProfileId === "claude" ? claudeAccountId : undefined,
    );
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
        aria-modal="true"
        aria-labelledby="create-session-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="create-session-dialog__header">
          <div>
            <h2 id="create-session-title" className="create-session-dialog__title">
              Nova sessão
            </h2>
            <p>Escolha onde e com qual agent você quer trabalhar.</p>
          </div>
          <button
            type="button"
            className="create-session-dialog__close"
            aria-label="Fechar"
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </header>

        <div className="create-session-dialog__body">
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
          <label className="create-session-dialog__worktree">
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(event) => setUseWorktree(event.target.checked)}
            />
            <span>
              <strong>Worktree isolado</strong>
              Cria uma branch agent-N em pasta irmã.
            </span>
          </label>
        )}

        <fieldset className="create-session-dialog__fieldset">
          <legend>Agent</legend>
          <div className="create-session-dialog__agents">
            {profiles.map((profile) => {
              const available = isAgentAvailable(profile.id);
              return (
                <button
                  key={profile.id}
                  type="button"
                  className={
                    profile.id === agentProfileId
                      ? "create-session-dialog__agent create-session-dialog__agent--active"
                      : "create-session-dialog__agent"
                  }
                  disabled={!available}
                  aria-pressed={profile.id === agentProfileId}
                  onClick={() => setAgentProfileId(profile.id)}
                >
                  <AgentIcon id={profile.id} />
                  <span>{profile.label}</span>
                  {!available && <small>Não instalado</small>}
                </button>
              );
            })}
          </div>
        </fieldset>

        {agentProfileId === "claude" && (
          <fieldset className="create-session-dialog__fieldset">
            <legend>Perfil Claude</legend>
            <div className="create-session-dialog__profiles">
              {claudeAccounts.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  className={
                    account.id === claudeAccountId
                      ? "create-session-dialog__profile create-session-dialog__profile--active"
                      : "create-session-dialog__profile"
                  }
                  aria-pressed={account.id === claudeAccountId}
                  onClick={() => setClaudeAccountId(account.id)}
                >
                  <span>{account.name}</span>
                  <small>
                    {account.id === DEFAULT_CLAUDE_ACCOUNT_ID
                      ? "Conta padrão"
                      : "Ambiente isolado"}
                  </small>
                </button>
              ))}
            </div>
            <span className="create-session-dialog__hint">
              O perfil fica lembrado para a próxima sessão.
            </span>
          </fieldset>
        )}
        </div>

        <div className="create-session-dialog__actions">
          <button type="button" className="agent-toolbar__button--ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="create-session-dialog__create"
            disabled={
              creating || (agentProfileId === "claude" && !claudeAccountId)
            }
            onClick={() => void validateAndCreate()}
          >
            <IconPlus size={14} />
            {creating ? "Criando…" : "Criar sessão"}
          </button>
        </div>
      </div>
    </div>
  );
}
