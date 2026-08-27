import { useEffect, useState } from "react";

import {
  LLAMA_HARDWARE_PROFILE,
  ORNITH_DEFAULT_GGUF,
  ORNITH_HF_FILE,
  ORNITH_HF_REPO,
  QWEN27_DEFAULT_GGUF,
  QWEN27_HF_FILE,
  buildAgentProfiles,
  sanitizeGgufPath,
} from "../../config/agents";
import {
  DEFAULT_CLAUDE_ACCOUNT_ID,
  loadClaudeAccountProfiles,
  type ClaudeAccountProfile,
} from "../../core/claude-accounts";
import {
  loadLastAgent,
  loadLastClaudeAccount,
  loadLastGgufPath,
  loadLastOllamaModel,
  loadLastOllamaThinkOff,
  loadRecentCwds,
  noteRecentCwd,
  saveLastAgent,
  saveLastClaudeAccount,
  saveLastGgufPath,
  saveLastOllamaModel,
  saveLastOllamaThinkOff,
  type LlamaAgentId,
} from "../../core/ui-preferences";
import {
  IconActivity,
  IconAgentClaude,
  IconAgentCodex,
  IconAgentCursor,
  IconAgentOllama,
  IconAgentOrnith,
  IconAgentQwen,
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
    extras?: {
      claudeAccountId?: string;
      ollamaModel?: string;
      ollamaThinkOff?: boolean;
      ggufPath?: string;
    },
  ) => void;
}

interface AgentCliStatus {
  antigravity: boolean;
  cursor: boolean;
  claude: boolean;
  codex: boolean;
  ollama: boolean;
  ornith: boolean;
}

let cliStatusCache: AgentCliStatus | null = null;
// `ollama list` starts the daemon on a cold machine, so the answer is kept
// for the app's lifetime like the CLI probe above.
let ollamaModelsCache: string[] | null = null;

function cliAvailable(status: AgentCliStatus, id: string): boolean {
  if (id === "shell") {
    return true;
  }
  // Same llama-cli binary as Ornith; not a separate probe.
  if (id === "qwen27") {
    return status.ornith;
  }
  return status[id as keyof AgentCliStatus] ?? true;
}

function folderChipLabel(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments.at(-1) ?? path;
}

function AgentIcon({ id }: { id: string }) {
  if (id === "antigravity") return <IconActivity size={18} />;
  if (id === "claude") return <IconAgentClaude size={18} />;
  if (id === "codex") return <IconAgentCodex size={18} />;
  if (id === "ollama") return <IconAgentOllama size={18} />;
  if (id === "ornith") return <IconAgentOrnith size={18} />;
  if (id === "qwen27") return <IconAgentQwen size={18} />;
  if (id === "shell") return <IconAgentShell size={18} />;
  return <IconAgentCursor size={18} />;
}

function isLlamaAgent(id: string): id is LlamaAgentId {
  return id === "ornith" || id === "qwen27";
}

function LlamaGgufFields({
  agentId,
  ggufPath,
  onGgufPath,
  hardwareDetail,
  downloadHint,
}: {
  agentId: LlamaAgentId;
  ggufPath: string;
  onGgufPath: (path: string) => void;
  hardwareDetail: string;
  downloadHint: string;
}) {
  const placeholder =
    agentId === "ornith" ? ORNITH_DEFAULT_GGUF : QWEN27_DEFAULT_GGUF;

  const browseGguf = async () => {
    const selected = await window.headTerminal.system.selectFile(
      ggufPath.trim() || undefined,
    );
    if (typeof selected === "string") {
      onGgufPath(selected);
    }
  };

  return (
    <fieldset className="create-session-dialog__fieldset">
      <legend>Modelo nesta máquina</legend>
      <label className="create-session-dialog__field">
        <span>Arquivo GGUF</span>
        <div className="create-session-dialog__cwd-row">
          <input
            type="text"
            value={ggufPath}
            onChange={(event) => onGgufPath(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
          />
          <button
            type="button"
            className="agent-toolbar__button--ghost"
            onClick={() => void browseGguf()}
          >
            Procurar…
          </button>
        </div>
      </label>
      <div className="create-session-dialog__hw">
        <strong>{LLAMA_HARDWARE_PROFILE}</strong>
        <span>{hardwareDetail}</span>
      </div>
      <span className="create-session-dialog__hint">{downloadHint}</span>
    </fieldset>
  );
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
  const [ensuringClis, setEnsuringClis] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaModel, setOllamaModel] = useState("");
  const [ollamaThinkOff, setOllamaThinkOff] = useState(false);
  const [ggufPath, setGgufPath] = useState("");
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        event.stopImmediatePropagation();
        return;
      }
      onClose();
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
      void window.headTerminal.git.getContext(target)
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
        ["antigravity", "cursor", "claude", "codex", "ollama", "ornith", "qwen27", "shell"].includes(
          lastAgent,
        )
          ? lastAgent
          : "cursor",
      );
      setClaudeAccountId(
        accounts.some((account) => account.id === lastAccount)
          ? lastAccount
          : DEFAULT_CLAUDE_ACCOUNT_ID,
      );
      setOllamaModel(loadLastOllamaModel());
      setOllamaThinkOff(loadLastOllamaThinkOff());
      setGgufPath(
        isLlamaAgent(lastAgent)
          ? loadLastGgufPath(lastAgent) || (
            lastAgent === "ornith" ? ORNITH_DEFAULT_GGUF : QWEN27_DEFAULT_GGUF
          )
          : "",
      );
      setRecentCwds(loadRecentCwds());
      if (cliStatusCache) {
        setCliStatus(cliStatusCache);
      }
      setEnsuringClis(true);
      void window.headTerminal.system.ensureAgentClis()
        .then((result) => {
          cliStatusCache = result.status;
          setCliStatus(result.status);
          if (
            lastAgent !== "shell" &&
            !cliAvailable(result.status, lastAgent)
          ) {
            setAgentProfileId(result.status.cursor ? "cursor" : "shell");
          }
        })
        .catch(() =>
          window.headTerminal.system.checkAgentClis().then((status) => {
            cliStatusCache = status;
            setCliStatus(status);
            if (
              lastAgent !== "shell" &&
              !cliAvailable(status, lastAgent)
            ) {
              setAgentProfileId(status.cursor ? "cursor" : "shell");
            }
          })
          .catch(() =>
            setCliStatus({
              antigravity: true,
              cursor: true,
              claude: true,
              codex: true,
              ollama: true,
              ornith: true,
            }),
          ),
        )
        .finally(() => setEnsuringClis(false));
    }
  }, [defaultCwd, open]);

  // Only asked for once the user actually wants a local model: the call
  // wakes the ollama daemon, which is not something opening the dialog
  // should do on its own.
  useEffect(() => {
    if (!open || agentProfileId !== "ollama") {
      return;
    }
    let cancelled = false;
    const apply = (models: string[]) => {
      if (cancelled) {
        return;
      }
      setOllamaModels(models);
      setOllamaModel((current) =>
        current || models[0] || "",
      );
    };
    if (ollamaModelsCache) {
      apply(ollamaModelsCache);
      return;
    }
    void window.headTerminal.system.listOllamaModels()
      .then((models) => {
        ollamaModelsCache = models;
        apply(models);
      })
      .catch(() => apply([]));
    return () => {
      cancelled = true;
    };
  }, [agentProfileId, open]);

  if (!open) {
    return null;
  }

  const profiles = Object.values(buildAgentProfiles());

  const isAgentAvailable = (id: string): boolean => {
    if (id === "shell") {
      return true;
    }
    if (!cliStatus) {
      return false;
    }
    return cliAvailable(cliStatus, id);
  };

  const validateAndCreate = async () => {
    if (creating) {
      return;
    }
    setCreating(true);
    const nextCwd = cwd.trim() || defaultCwd;
    let exists = false;
    try {
      exists = await window.headTerminal.system.pathExists(nextCwd);
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
        sessionCwd = await window.headTerminal.git.createWorktree(nextCwd);
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
    if (agentProfileId === "ollama") {
      saveLastOllamaModel(ollamaModel);
      saveLastOllamaThinkOff(ollamaThinkOff);
    }
    if (isLlamaAgent(agentProfileId)) {
      saveLastGgufPath(agentProfileId, ggufPath);
    }
    onCreate(sessionCwd, agentProfileId, {
      claudeAccountId:
        agentProfileId === "claude" ? claudeAccountId : undefined,
      ollamaModel:
        agentProfileId === "ollama" ? ollamaModel.trim() : undefined,
      ollamaThinkOff:
        agentProfileId === "ollama" ? ollamaThinkOff : undefined,
      ggufPath: isLlamaAgent(agentProfileId)
        ? sanitizeGgufPath(ggufPath)
        : undefined,
    });
    onClose();
  };

  const browseDirectory = async () => {
    const selected = await window.headTerminal.system.selectDirectory(
      cwd || defaultCwd,
    );
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
              placeholder="C:\Users\projeto"
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
                title={item}
                onClick={() => {
                  setCwd(item);
                  setCwdError(null);
                }}
              >
                {folderChipLabel(item)}
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
              const installing = ensuringClis
                && profile.id !== "shell"
                && profile.id !== "antigravity"
                && !available;
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
                  onClick={() => {
                    setAgentProfileId(profile.id);
                    if (isLlamaAgent(profile.id)) {
                      setGgufPath(
                        loadLastGgufPath(profile.id)
                          || (profile.id === "ornith"
                            ? ORNITH_DEFAULT_GGUF
                            : QWEN27_DEFAULT_GGUF),
                      );
                    }
                  }}
                >
                  <AgentIcon id={profile.id} />
                  <span>{profile.label}</span>
                  {installing && <small>Instalando…</small>}
                  {!available && !installing && <small>Não instalado</small>}
                </button>
              );
            })}
          </div>
        </fieldset>

        {agentProfileId === "ollama" && (
          <fieldset className="create-session-dialog__fieldset">
            <legend>Modelo local</legend>
            {ollamaModels.length > 0 && (
              <div className="create-session-dialog__profiles">
                {ollamaModels.map((model) => (
                  <button
                    key={model}
                    type="button"
                    className={
                      model === ollamaModel.trim()
                        ? "create-session-dialog__profile create-session-dialog__profile--active"
                        : "create-session-dialog__profile"
                    }
                    aria-pressed={model === ollamaModel.trim()}
                    onClick={() => setOllamaModel(model)}
                  >
                    <span>{model}</span>
                    <small>ollama run</small>
                  </button>
                ))}
              </div>
            )}
            <label className="create-session-dialog__field">
              <span>Outro modelo</span>
              <input
                type="text"
                value={ollamaModel}
                onChange={(event) => setOllamaModel(event.target.value)}
                placeholder="qwen38-27b-uncensored:latest"
              />
            </label>
            <label className="create-session-dialog__worktree">
              <input
                type="checkbox"
                checked={ollamaThinkOff}
                onChange={(event) => setOllamaThinkOff(event.target.checked)}
              />
              <span>
                <strong>Thinking desligado</strong>
                Inicia com --think=false para o modelo responder em vez de raciocinar até estourar o contexto.
              </span>
            </label>
            <span className="create-session-dialog__hint">
              {ollamaModels.length > 0
                ? "O modelo fica lembrado para a próxima sessão."
                : "Nenhum modelo listado — confira se o serviço do ollama está no ar ou digite o nome."}
            </span>
          </fieldset>
        )}

        {agentProfileId === "ornith" && (
          <LlamaGgufFields
            agentId="ornith"
            ggufPath={ggufPath}
            onGgufPath={setGgufPath}
            hardwareDetail="MoE: experts na RAM (--cpu-moe), contexto 16k. O tweet (--n-cpu-moe 24, 170k) estoura VRAM nesta placa. Não copie estes flags para outra GPU."
            downloadHint={`O GGUF não vai no git — só o caminho nesta máquina. Arquivo típico: ${ORNITH_HF_FILE} (${ORNITH_HF_REPO}).`}
          />
        )}

        {agentProfileId === "qwen27" && (
          <LlamaGgufFields
            agentId="qwen27"
            ggufPath={ggufPath}
            onGgufPath={setGgufPath}
            hardwareDetail="27B denso: a placa já está cheia (~6,3 GB). ~4 tok/s com metade das camadas na CPU. Thinking off, mlock. Não use este fit em outra quantidade de VRAM."
            downloadHint={`O GGUF não vai no git — só o caminho nesta máquina. Arquivo típico: ${QWEN27_HF_FILE}.`}
          />
        )}

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
              creating
              || !isAgentAvailable(agentProfileId)
              || (agentProfileId === "claude" && !claudeAccountId)
              || (agentProfileId === "ollama" && !ollamaModel.trim())
              || (isLlamaAgent(agentProfileId) && !sanitizeGgufPath(ggufPath))
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
