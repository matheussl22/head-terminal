import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";

import { buildAgentProfiles } from "../../config/agents";
import { resolveDefaultCwd } from "../../core/agent-launcher";
import {
  createClaudeAccountProfile,
  DEFAULT_CLAUDE_ACCOUNT_ID,
  deleteClaudeAccountProfile,
  loadClaudeAccountProfiles,
  renameClaudeAccountProfile,
  type ClaudeAccountProfile,
} from "../../core/claude-accounts";
import { logEvent } from "../../core/logger";
import { fetchMcpServers, type McpServerStatus } from "../../core/mcp-bridge";
import {
  persistOpenAiApiKey,
  resolveOpenAiApiKey,
} from "../../core/openai-credentials";
import { useSessionStore } from "../../core/session-manager";
import {
  loadCopyOnSelect,
  loadFontSize,
  loadRendererPreference,
  saveCopyOnSelect,
  saveFontSize,
  saveRendererPreference,
  type TerminalRenderer,
} from "../../core/ui-preferences";
import {
  IconAgentClaude,
  IconCheck,
  IconClose,
  IconLock,
  IconPencil,
  IconPlug,
  IconPlus,
  IconSliders,
  IconTrash,
} from "../ui/Icons";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

interface McpAgentState {
  servers: McpServerStatus[];
  error: string | null;
  loading: boolean;
}

type SettingsSection = "terminal" | "profiles" | "integrations";

function statusClass(status: string): string {
  if (status.includes("✔")) return "settings-mcp-status--ok";
  if (status.includes("✘")) return "settings-mcp-status--error";
  return "settings-mcp-status--pending";
}

const AGENTS_WITH_MCP_SUPPORT = new Set(["claude", "cursor"]);

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const sessions = useSessionStore((state) => state.sessions);
  const [activeSection, setActiveSection] =
    useState<SettingsSection>("profiles");
  const [fontSize, setFontSize] = useState(12);
  const [renderer, setRenderer] = useState<TerminalRenderer>("auto");
  const [copyOnSelect, setCopyOnSelect] = useState(false);
  const [claudeAccounts, setClaudeAccounts] = useState<ClaudeAccountProfile[]>([]);
  const [claudeAccountDrafts, setClaudeAccountDrafts] = useState<
    Record<string, string>
  >({});
  const [newClaudeAccountName, setNewClaudeAccountName] = useState("");
  const [addingProfile, setAddingProfile] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [deletingAccountId, setDeletingAccountId] = useState<string | null>(null);
  const [claudeAccountError, setClaudeAccountError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyEdited, setApiKeyEdited] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [apiKeySaveError, setApiKeySaveError] = useState<string | null>(null);
  const [savingApiKey, setSavingApiKey] = useState(false);
  const [mcpByAgent, setMcpByAgent] = useState<Record<string, McpAgentState>>({});

  const refreshAccounts = () => {
    const accounts = loadClaudeAccountProfiles();
    setClaudeAccounts(accounts);
    setClaudeAccountDrafts(
      Object.fromEntries(accounts.map((account) => [account.id, account.name])),
    );
  };

  useEffect(() => {
    if (!open) return;

    setFontSize(loadFontSize());
    setRenderer(loadRendererPreference());
    setCopyOnSelect(loadCopyOnSelect());
    setNewClaudeAccountName("");
    setAddingProfile(false);
    setEditingAccountId(null);
    setClaudeAccountError(null);
    setApiKeySaveError(null);
    refreshAccounts();
  }, [open]);

  useEffect(() => {
    if (!open || activeSection !== "integrations") return;

    setApiKeyEdited(false);
    setApiKey("");
    const frame = requestAnimationFrame(() => {
      void resolveOpenAiApiKey().then((stored) => {
        setHasStoredKey(Boolean(stored));
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeSection, open]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const linkedSessionCount = (accountId: string): number =>
    sessions.filter((session) => {
      if (accountId === DEFAULT_CLAUDE_ACCOUNT_ID) {
        return (
          session.agentProfileId === "claude" &&
          (!session.claudeAccountId ||
            session.claudeAccountId === DEFAULT_CLAUDE_ACCOUNT_ID)
        );
      }
      return session.claudeAccountId === accountId;
    }).length;

  const commitAccountName = (account: ClaudeAccountProfile) => {
    try {
      renameClaudeAccountProfile(
        account.id,
        claudeAccountDrafts[account.id] ?? account.name,
      );
      setEditingAccountId(null);
      setClaudeAccountError(null);
      refreshAccounts();
    } catch (error) {
      setClaudeAccountDrafts((drafts) => ({
        ...drafts,
        [account.id]: account.name,
      }));
      setClaudeAccountError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const addClaudeProfile = async () => {
    try {
      createClaudeAccountProfile(newClaudeAccountName, await homeDir());
      setNewClaudeAccountName("");
      setAddingProfile(false);
      setClaudeAccountError(null);
      refreshAccounts();
    } catch (error) {
      setClaudeAccountError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const deleteClaudeProfile = async (account: ClaudeAccountProfile) => {
    const linked = linkedSessionCount(account.id);
    if (linked > 0) {
      setClaudeAccountError(
        `Feche ${linked} sessão(ões) vinculada(s) antes de excluir este perfil.`,
      );
      return;
    }

    const confirmed = await confirmDialog(
      `Excluir “${account.name}”?\n\nCredenciais, configurações e histórico locais deste perfil serão removidos. Sua conta Claude não será excluída.`,
      {
        title: "Excluir perfil Claude",
        kind: "warning",
        okLabel: "Excluir",
        cancelLabel: "Cancelar",
      },
    );
    if (!confirmed) return;

    setDeletingAccountId(account.id);
    setClaudeAccountError(null);
    try {
      if (account.configDir) {
        await invoke("delete_claude_profile_dir", { path: account.configDir });
      }
      deleteClaudeAccountProfile(account.id);
      refreshAccounts();
    } catch (error) {
      setClaudeAccountError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setDeletingAccountId(null);
    }
  };

  const checkMcpServers = () => {
    const agents = Object.values(buildAgentProfiles()).filter((profile) =>
      AGENTS_WITH_MCP_SUPPORT.has(profile.id),
    );
    setMcpByAgent(
      Object.fromEntries(
        agents.map((profile) => [
          profile.id,
          { servers: [], error: null, loading: true },
        ]),
      ),
    );
    window.setTimeout(() => {
      void resolveDefaultCwd().then((cwd) => {
        for (const profile of agents) {
          void fetchMcpServers(cwd, profile.id)
            .then((payload) => {
              setMcpByAgent((previous) => ({
                ...previous,
                [profile.id]: { ...payload, loading: false },
              }));
            })
            .catch((error) => {
              setMcpByAgent((previous) => ({
                ...previous,
                [profile.id]: {
                  servers: [],
                  error: String(error),
                  loading: false,
                },
              }));
            });
        }
      });
    }, 0);
  };

  const saveApiKey = async () => {
    setSavingApiKey(true);
    setApiKeySaveError(null);
    try {
      await persistOpenAiApiKey(apiKey);
      setHasStoredKey(Boolean(apiKey.trim()));
      setApiKeyEdited(false);
      setApiKey("");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logEvent("error", "settings.api_key_save_failed", { message });
      setApiKeySaveError(message);
    } finally {
      setSavingApiKey(false);
    }
  };

  if (!open) return null;

  return (
    <div className="create-session-backdrop" onClick={onClose}>
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Configurações"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-dialog__header">
          <div>
            <h2>Configurações</h2>
            <span>Personalize o terminal e suas integrações</span>
          </div>
          <button
            type="button"
            className="settings-icon-button"
            aria-label="Fechar configurações"
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </header>

        <div className="settings-dialog__body">
          <nav className="settings-nav" aria-label="Seções das configurações">
            <button
              type="button"
              className={activeSection === "terminal" ? "settings-nav__item settings-nav__item--active" : "settings-nav__item"}
              onClick={() => setActiveSection("terminal")}
            >
              <IconSliders size={16} />
              Terminal
            </button>
            <button
              type="button"
              className={activeSection === "profiles" ? "settings-nav__item settings-nav__item--active" : "settings-nav__item"}
              onClick={() => setActiveSection("profiles")}
            >
              <IconAgentClaude size={16} />
              Perfis Claude
            </button>
            <button
              type="button"
              className={activeSection === "integrations" ? "settings-nav__item settings-nav__item--active" : "settings-nav__item"}
              onClick={() => setActiveSection("integrations")}
            >
              <IconPlug size={16} />
              Integrações
            </button>
          </nav>

          <main className="settings-content">
            {activeSection === "terminal" && (
              <section className="settings-section">
                <div className="settings-section__header">
                  <h3>Terminal</h3>
                  <p>Aparência e comportamento de todos os novos terminais.</p>
                </div>
                <div className="settings-card settings-card--rows">
                  <label className="settings-row">
                    <span>
                      <strong>Tamanho da fonte</strong>
                      <small>Entre 8 e 24 pixels</small>
                    </span>
                    <input
                      type="number"
                      min={8}
                      max={24}
                      value={fontSize}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setFontSize(value);
                        saveFontSize(value);
                      }}
                    />
                  </label>
                  <label className="settings-row">
                    <span>
                      <strong>Renderização</strong>
                      <small>WebGL é mais rápido; DOM é mais compatível</small>
                    </span>
                    <select
                      value={renderer}
                      onChange={(event) => {
                        const value = event.target.value as TerminalRenderer;
                        setRenderer(value);
                        saveRendererPreference(value);
                      }}
                    >
                      <option value="auto">Automática</option>
                      <option value="webgl">WebGL</option>
                      <option value="dom">DOM</option>
                    </select>
                  </label>
                  <label className="settings-row">
                    <span>
                      <strong>Copiar ao selecionar</strong>
                      <small>Envia o texto selecionado para a área de transferência</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={copyOnSelect}
                      onChange={(event) => {
                        setCopyOnSelect(event.target.checked);
                        saveCopyOnSelect(event.target.checked);
                      }}
                    />
                  </label>
                </div>
              </section>
            )}

            {activeSection === "profiles" && (
              <section className="settings-section">
                <div className="settings-section__header settings-section__header--action">
                  <div>
                    <h3>Perfis Claude</h3>
                    <p>Cada perfil mantém login, histórico e configurações separados.</p>
                  </div>
                  <button
                    type="button"
                    className="settings-primary-button"
                    onClick={() => {
                      setAddingProfile(true);
                      setClaudeAccountError(null);
                    }}
                  >
                    <IconPlus size={14} />
                    Novo perfil
                  </button>
                </div>

                {claudeAccountError && (
                  <div className="settings-alert settings-alert--error">
                    {claudeAccountError}
                  </div>
                )}

                {addingProfile && (
                  <form
                    className="settings-new-profile"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void addClaudeProfile();
                    }}
                  >
                    <div>
                      <strong>Novo perfil</strong>
                      <span>Escolha um nome fácil de reconhecer nas sessões.</span>
                    </div>
                    <input
                      autoFocus
                      type="text"
                      maxLength={40}
                      value={newClaudeAccountName}
                      placeholder="Ex.: Empresa"
                      onChange={(event) => {
                        setNewClaudeAccountName(event.target.value);
                        setClaudeAccountError(null);
                      }}
                    />
                    <button
                      type="button"
                      className="settings-secondary-button"
                      onClick={() => {
                        setAddingProfile(false);
                        setNewClaudeAccountName("");
                      }}
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      className="settings-primary-button"
                      disabled={!newClaudeAccountName.trim()}
                    >
                      Criar perfil
                    </button>
                  </form>
                )}

                <div className="settings-profile-list">
                  {claudeAccounts.map((account) => {
                    const linked = linkedSessionCount(account.id);
                    const isDefault = account.id === DEFAULT_CLAUDE_ACCOUNT_ID;
                    const isEditing = editingAccountId === account.id;
                    return (
                      <article key={account.id} className="settings-profile-card">
                        <span className="settings-profile-card__avatar">
                          {account.name.trim().charAt(0).toLocaleUpperCase() || "C"}
                        </span>
                        <div className="settings-profile-card__body">
                          <div className="settings-profile-card__title">
                            {isEditing ? (
                              <input
                                autoFocus
                                className="settings-profile-card__name-input"
                                maxLength={40}
                                value={claudeAccountDrafts[account.id] ?? account.name}
                                onChange={(event) => {
                                  setClaudeAccountDrafts((drafts) => ({
                                    ...drafts,
                                    [account.id]: event.target.value,
                                  }));
                                  setClaudeAccountError(null);
                                }}
                                onBlur={() => commitAccountName(account)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") event.currentTarget.blur();
                                  if (event.key === "Escape") {
                                    event.stopPropagation();
                                    setClaudeAccountDrafts((drafts) => ({
                                      ...drafts,
                                      [account.id]: account.name,
                                    }));
                                    setEditingAccountId(null);
                                  }
                                }}
                              />
                            ) : (
                              <strong>{account.name}</strong>
                            )}
                            <span className={isDefault ? "settings-profile-tag" : "settings-profile-tag settings-profile-tag--isolated"}>
                              {isDefault ? "Padrão" : "Isolado"}
                            </span>
                          </div>
                          <span className="settings-profile-card__detail">
                            {isDefault
                              ? "Usa a configuração global ~/.claude"
                              : "Login e histórico reutilizados apenas neste perfil"}
                          </span>
                          {linked > 0 && (
                            <span className="settings-profile-card__sessions">
                              {linked} sessão(ões) vinculada(s)
                            </span>
                          )}
                        </div>
                        <div className="settings-profile-card__actions">
                          <button
                            type="button"
                            className="settings-icon-button"
                            title={isEditing ? "Salvar nome" : "Renomear perfil"}
                            aria-label={isEditing ? "Salvar nome" : `Renomear ${account.name}`}
                            onMouseDown={(event) => {
                              if (isEditing) event.preventDefault();
                            }}
                            onClick={() => {
                              if (isEditing) commitAccountName(account);
                              else setEditingAccountId(account.id);
                            }}
                          >
                            {isEditing ? <IconCheck /> : <IconPencil />}
                          </button>
                          {isDefault ? (
                            <span className="settings-icon-button settings-icon-button--static" title="O perfil padrão não pode ser excluído">
                              <IconLock />
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="settings-icon-button settings-icon-button--danger"
                              disabled={linked > 0 || deletingAccountId === account.id}
                              title={linked > 0 ? "Feche as sessões vinculadas para excluir" : "Excluir perfil"}
                              aria-label={`Excluir ${account.name}`}
                              onClick={() => void deleteClaudeProfile(account)}
                            >
                              <IconTrash />
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            {activeSection === "integrations" && (
              <section className="settings-section">
                <div className="settings-section__header">
                  <h3>Integrações</h3>
                  <p>Credenciais externas e servidores conectados aos agentes.</p>
                </div>

                <div className="settings-card">
                  <div className="settings-card__header">
                    <div>
                      <strong>OpenAI</strong>
                      <span>Chave usada pelos recursos de voz.</span>
                    </div>
                    {hasStoredKey && !apiKeyEdited && (
                      <span className="settings-status settings-status--ok">Configurada</span>
                    )}
                  </div>
                  <div className="settings-inline-form">
                    <input
                      type="password"
                      value={apiKey}
                      autoComplete="off"
                      placeholder={hasStoredKey ? "Digite para substituir" : "sk-..."}
                      onChange={(event) => {
                        setApiKey(event.target.value);
                        setApiKeyEdited(true);
                      }}
                    />
                    <button
                      type="button"
                      className="settings-primary-button"
                      disabled={!apiKeyEdited || savingApiKey}
                      onClick={() => void saveApiKey()}
                    >
                      Salvar chave
                    </button>
                  </div>
                  {apiKeySaveError && (
                    <span className="settings-error-text">{apiKeySaveError}</span>
                  )}
                </div>

                <div className="settings-card">
                  <div className="settings-card__header">
                    <div>
                      <strong>MCP servers</strong>
                      <span>A verificação roda somente quando solicitada.</span>
                    </div>
                    <button
                      type="button"
                      className="settings-secondary-button"
                      onClick={checkMcpServers}
                    >
                      Verificar
                    </button>
                  </div>
                  <ul className="settings-mcp-list">
                    {Object.values(buildAgentProfiles())
                      .filter((profile) => profile.id !== "shell")
                      .map((profile) => {
                        const state = mcpByAgent[profile.id];
                        return (
                          <li key={profile.id} className="settings-mcp-item">
                            <span className="settings-mcp-item__name">{profile.label}</span>
                            {!AGENTS_WITH_MCP_SUPPORT.has(profile.id) ? (
                              <span className="settings-mcp-status--unsupported">Não suportado</span>
                            ) : !state ? (
                              <span className="settings-mcp-item__detail">Não verificado</span>
                            ) : state.loading ? (
                              <span className="settings-mcp-item__detail">Verificando…</span>
                            ) : state.error ? (
                              <span className="settings-mcp-status--error">{state.error}</span>
                            ) : state.servers.length === 0 ? (
                              <span className="settings-mcp-item__detail">Nenhum servidor</span>
                            ) : (
                              <span className="settings-mcp-item__detail">
                                {state.servers.map((server) => (
                                  <span
                                    key={server.name}
                                    className={statusClass(server.status)}
                                    title={server.target}
                                  >
                                    {server.name} ({server.status}){" "}
                                  </span>
                                ))}
                              </span>
                            )}
                          </li>
                        );
                      })}
                  </ul>
                </div>
              </section>
            )}
          </main>
        </div>

        <footer className="settings-dialog__footer">
          <span>Alterações salvas automaticamente</span>
          <button type="button" className="settings-secondary-button" onClick={onClose}>
            Fechar
          </button>
        </footer>
      </div>
    </div>
  );
}
