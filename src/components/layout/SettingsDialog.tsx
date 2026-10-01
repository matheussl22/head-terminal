import { useEffect, useState } from "react";


import { buildAgentProfiles } from "../../config/agents";
import {
  getTheme,
  resolveThemeId,
  THEMES,
  type AppTheme,
  type ThemePreference,
} from "../../config/themes";
import { resolveDefaultCwd } from "../../core/agent-launcher";
import {
  createClaudeAccountProfile,
  DEFAULT_CLAUDE_ACCOUNT_ID,
  deleteClaudeAccountProfile,
  loadClaudeAccountProfiles,
  renameClaudeAccountProfile,
  type ClaudeAccountProfile,
} from "../../core/claude-accounts";
import { logError, logEvent } from "../../core/logger";
import { fetchMcpServers, type McpServerStatus } from "../../core/mcp-bridge";
import {
  persistOpenAiApiKey,
  hasOpenAiApiKey,
} from "../../core/openai-credentials";
import { useSessionStore } from "../../core/session-manager";
import {
  LOCALE_NAMES,
  locale,
  msg,
  setLocale,
  type LanguagePreference,
  type Locale,
} from "../../i18n";
import { setThemePreference } from "../../core/theme-manager";
import { isMacHost } from "../../core/platform-info";
import { forEachTerminal } from "../../core/terminal-registry";
import {
  DEFAULT_HIBERNATE_AFTER_MINUTES,
  HIBERNATE_AFTER_OPTIONS,
  loadCopyOnSelect,
  loadHibernateAfterMinutes,
  loadFontSize,
  loadOptionAsMeta,
  loadRendererPreference,
  loadThemePreference,
  saveCopyOnSelect,
  saveHibernateAfterMinutes,
  saveFontSize,
  saveOptionAsMeta,
  saveRendererPreference,
  type TerminalRenderer,
} from "../../core/ui-preferences";
import {
  IconAgentClaude,
  IconCheck,
  IconClose,
  IconLock,
  IconPencil,
  IconPhone,
  IconPlug,
  IconPlus,
  IconSliders,
  IconTrash,
} from "../ui/Icons";
import { RemoteSettings } from "./RemoteSettings";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

interface McpAgentState {
  servers: McpServerStatus[];
  error: string | null;
  loading: boolean;
}

type SettingsSection = "terminal" | "profiles" | "integrations" | "phone";

function statusClass(status: string): string {
  if (status.includes("✔")) return "settings-mcp-status--ok";
  if (status.includes("✘")) return "settings-mcp-status--error";
  return "settings-mcp-status--pending";
}

const AGENTS_WITH_MCP_SUPPORT = new Set(["claude", "cursor"]);

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

interface ThemeCardProps {
  theme: AppTheme;
  label: string;
  hint?: string;
  active: boolean;
  onSelect: () => void;
}

function ThemeCard({ theme, label, hint, active, onSelect }: ThemeCardProps) {
  const { terminal } = theme;
  return (
    <button
      type="button"
      className={
        active
          ? "settings-theme-card settings-theme-card--active"
          : "settings-theme-card"
      }
      aria-pressed={active}
      onClick={onSelect}
    >
      <span
        className="settings-theme-card__preview"
        style={{ background: terminal.background, color: terminal.foreground }}
      >
        <span>
          <span style={{ color: terminal.green }}>$</span> head-terminal
        </span>
        <span className="settings-theme-card__swatches" aria-hidden="true">
          {[
            terminal.red,
            terminal.yellow,
            terminal.green,
            terminal.cyan,
            terminal.blue,
            terminal.magenta,
          ].map((color, index) => (
            <span
              key={index}
              className="settings-theme-card__swatch"
              style={{ background: color }}
            />
          ))}
        </span>
      </span>
      <span className="settings-theme-card__label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </button>
  );
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const sessions = useSessionStore((state) => state.sessions);
  const [activeSection, setActiveSection] =
    useState<SettingsSection>("profiles");
  const [fontSize, setFontSize] = useState(12);
  const [themePreference, setThemePreferenceState] =
    useState<ThemePreference>("graphite");
  const [renderer, setRenderer] = useState<TerminalRenderer>("auto");
  const [copyOnSelect, setCopyOnSelect] = useState(false);
  const [optionAsMeta, setOptionAsMeta] = useState(false);
  const [hibernateAfter, setHibernateAfter] = useState(DEFAULT_HIBERNATE_AFTER_MINUTES);
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
  const [languagePreference, setLanguagePreferenceState] =
    useState<LanguagePreference>("auto");
  const [systemLocale, setSystemLocale] = useState<Locale>(locale);

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
    setThemePreferenceState(loadThemePreference());
    setRenderer(loadRendererPreference());
    setCopyOnSelect(loadCopyOnSelect());
    setOptionAsMeta(loadOptionAsMeta());
    setHibernateAfter(loadHibernateAfterMinutes());
    setNewClaudeAccountName("");
    setAddingProfile(false);
    setEditingAccountId(null);
    setClaudeAccountError(null);
    setApiKeySaveError(null);
    refreshAccounts();
    void window.headTerminal.app
      .getStartupContext()
      .then((context) => {
        setLanguagePreferenceState(context.languagePreference);
        setSystemLocale(context.systemLocale);
      })
      .catch((error) => logError("settings.language_load_failed", error));
  }, [open]);

  useEffect(() => {
    if (!open || activeSection !== "integrations") return;

    setApiKeyEdited(false);
    setApiKey("");
    const frame = requestAnimationFrame(() => {
      void hasOpenAiApiKey().then((stored) => {
        setHasStoredKey(stored);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeSection, open]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
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
      const { homeDir } = await window.headTerminal.system.getPlatform();
      createClaudeAccountProfile(newClaudeAccountName, homeDir);
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
        msg.settings.deleteBlocked(linked),
      );
      return;
    }

    const confirmed = await window.headTerminal.system.confirm({
      title: msg.settings.deleteConfirmTitle,
      message: msg.settings.deleteConfirmMessage(account.name),
      detail: msg.settings.deleteConfirmDetail,
      confirmLabel: msg.settings.deleteConfirm,
      cancelLabel: msg.settings.cancel,
    });
    if (!confirmed) return;

    setDeletingAccountId(account.id);
    setClaudeAccountError(null);
    try {
      if (account.configDir) {
        await window.headTerminal.system.deleteClaudeProfile(account.configDir);
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
        aria-label={msg.settings.title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-dialog__header">
          <div>
            <h2>{msg.settings.title}</h2>
            <span>{msg.settings.subtitle}</span>
          </div>
          <button
            type="button"
            className="settings-icon-button"
            aria-label={msg.settings.closeAria}
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </header>

        <div className="settings-dialog__body">
          <nav className="settings-nav" aria-label={msg.settings.sectionsAria}>
            <button
              type="button"
              className={activeSection === "terminal" ? "settings-nav__item settings-nav__item--active" : "settings-nav__item"}
              onClick={() => setActiveSection("terminal")}
            >
              <IconSliders size={16} />
              {msg.settings.terminal}
            </button>
            <button
              type="button"
              className={activeSection === "profiles" ? "settings-nav__item settings-nav__item--active" : "settings-nav__item"}
              onClick={() => setActiveSection("profiles")}
            >
              <IconAgentClaude size={16} />
              {msg.settings.profiles}
            </button>
            <button
              type="button"
              className={activeSection === "integrations" ? "settings-nav__item settings-nav__item--active" : "settings-nav__item"}
              onClick={() => setActiveSection("integrations")}
            >
              <IconPlug size={16} />
              {msg.settings.integrations}
            </button>
            <button
              type="button"
              className={activeSection === "phone" ? "settings-nav__item settings-nav__item--active" : "settings-nav__item"}
              onClick={() => setActiveSection("phone")}
            >
              <IconPhone size={16} />
              {msg.settings.phone}
            </button>
          </nav>

          <main className="settings-content">
            {activeSection === "terminal" && (
              <section className="settings-section">
                <div className="settings-section__header">
                  <h3>{msg.settings.terminal}</h3>
                  <p>{msg.settings.terminalDescription}</p>
                </div>
                <div className="settings-card settings-card--rows">
                  <label className="settings-row">
                    <span>
                      <strong>{msg.settings.language}</strong>
                      <small>{msg.settings.languageHint}</small>
                    </span>
                    <select
                      className="settings-select--wide"
                      value={languagePreference}
                      onChange={(event) => {
                        const value = event.target.value as LanguagePreference;
                        setLanguagePreferenceState(value);
                        // Main saves it and switches its menu and dialogs;
                        // the renderer then switches to what "auto" means here.
                        void window.headTerminal.app
                          .setLanguage(value)
                          .then((next) => {
                            setLocale(next);
                            document.documentElement.lang = next;
                          })
                          .catch((error) => logError("settings.language_save_failed", error));
                      }}
                    >
                      <option value="auto">
                        {msg.settings.languageAuto(LOCALE_NAMES[systemLocale])}
                      </option>
                      <option value="pt-BR">{LOCALE_NAMES["pt-BR"]}</option>
                      <option value="en">{LOCALE_NAMES.en}</option>
                    </select>
                  </label>
                  <div className="settings-row">
                    <span>
                      <strong>{msg.settings.theme}</strong>
                      <small>{msg.settings.themeHint}</small>
                    </span>
                  </div>
                  <div
                    className="settings-theme-grid"
                    role="radiogroup"
                    aria-label={msg.settings.theme}
                  >
                    <ThemeCard
                      theme={getTheme(resolveThemeId("system", systemPrefersDark()))}
                      label={msg.settings.themeAuto}
                      hint={msg.settings.themeAutoHint}
                      active={themePreference === "system"}
                      onSelect={() => {
                        setThemePreferenceState("system");
                        setThemePreference("system");
                      }}
                    />
                    {THEMES.map((theme) => (
                      <ThemeCard
                        key={theme.id}
                        theme={theme}
                        label={theme.name}
                        hint={theme.kind === "light" ? msg.settings.themeLight : msg.settings.themeDark}
                        active={themePreference === theme.id}
                        onSelect={() => {
                          setThemePreferenceState(theme.id);
                          setThemePreference(theme.id);
                        }}
                      />
                    ))}
                  </div>
                  <label className="settings-row">
                    <span>
                      <strong>{msg.settings.fontSize}</strong>
                      <small>{msg.settings.fontSizeHint}</small>
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
                      <strong>{msg.settings.renderer}</strong>
                      <small>{msg.settings.rendererHint}</small>
                    </span>
                    <select
                      value={renderer}
                      onChange={(event) => {
                        const value = event.target.value as TerminalRenderer;
                        setRenderer(value);
                        saveRendererPreference(value);
                      }}
                    >
                      <option value="auto">{msg.settings.rendererAuto}</option>
                      <option value="webgl">WebGL</option>
                      <option value="dom">DOM</option>
                    </select>
                  </label>
                  <label className="settings-row">
                    <span>
                      <strong>{msg.settings.copyOnSelect}</strong>
                      <small>{msg.settings.copyOnSelectHint}</small>
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
                  {isMacHost() && (
                    <label className="settings-row">
                      <span>
                        <strong>{msg.settings.optionAsMeta}</strong>
                        <small>{msg.settings.optionAsMetaHint}</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={optionAsMeta}
                        onChange={(event) => {
                          const enabled = event.target.checked;
                          setOptionAsMeta(enabled);
                          saveOptionAsMeta(enabled);
                          // Open terminals too: it changes what a key types.
                          forEachTerminal((_paneId, handle) => {
                            handle.terminal.options.macOptionIsMeta = enabled;
                          });
                        }}
                      />
                    </label>
                  )}
                  <label className="settings-row">
                    <span>
                      <strong>{msg.settings.hibernate}</strong>
                      <small>{msg.settings.hibernateHint}</small>
                    </span>
                    <select
                      value={hibernateAfter}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setHibernateAfter(value);
                        saveHibernateAfterMinutes(value);
                      }}
                    >
                      {HIBERNATE_AFTER_OPTIONS.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {minutes === 0
                            ? msg.settings.hibernateOff
                            : msg.settings.hibernateMinutes(minutes)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

              </section>
            )}

            {activeSection === "profiles" && (
              <section className="settings-section">
                <div className="settings-section__header settings-section__header--action">
                  <div>
                    <h3>{msg.settings.profiles}</h3>
                    <p>{msg.settings.profilesDescription}</p>
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
                    {msg.settings.newProfile}
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
                      <strong>{msg.settings.newProfile}</strong>
                      <span>{msg.settings.newProfileHint}</span>
                    </div>
                    <input
                      autoFocus
                      type="text"
                      maxLength={40}
                      value={newClaudeAccountName}
                      placeholder={msg.settings.newProfilePlaceholder}
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
                      {msg.settings.cancel}
                    </button>
                    <button
                      type="submit"
                      className="settings-primary-button"
                      disabled={!newClaudeAccountName.trim()}
                    >
                      {msg.settings.createProfile}
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
                              {isDefault ? msg.settings.defaultTag : msg.settings.isolatedTag}
                            </span>
                          </div>
                          <span className="settings-profile-card__detail">
                            {isDefault
                              ? msg.settings.defaultDetail
                              : msg.settings.isolatedDetail}
                          </span>
                          {linked > 0 && (
                            <span className="settings-profile-card__sessions">
                              {msg.settings.linkedSessions(linked)}
                            </span>
                          )}
                        </div>
                        <div className="settings-profile-card__actions">
                          <button
                            type="button"
                            className="settings-icon-button"
                            title={isEditing ? msg.settings.saveName : msg.settings.renameProfile}
                            aria-label={isEditing ? msg.settings.saveName : msg.settings.renameProfileAria(account.name)}
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
                            <span className="settings-icon-button settings-icon-button--static" title={msg.settings.defaultCannotBeDeleted}>
                              <IconLock />
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="settings-icon-button settings-icon-button--danger"
                              disabled={linked > 0 || deletingAccountId === account.id}
                              title={linked > 0 ? msg.settings.closeLinkedToDelete : msg.settings.deleteProfile}
                              aria-label={msg.settings.deleteProfileAria(account.name)}
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
                  <h3>{msg.settings.integrations}</h3>
                  <p>{msg.settings.integrationsDescription}</p>
                </div>

                <div className="settings-card">
                  <div className="settings-card__header">
                    <div>
                      <strong>OpenAI</strong>
                      <span>{msg.settings.openAiHint}</span>
                    </div>
                    {hasStoredKey && !apiKeyEdited && (
                      <span className="settings-status settings-status--ok">{msg.settings.apiKeyConfigured}</span>
                    )}
                  </div>
                  <div className="settings-inline-form">
                    <input
                      type="password"
                      value={apiKey}
                      autoComplete="off"
                      placeholder={hasStoredKey ? msg.settings.apiKeyReplacePlaceholder : "sk-..."}
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
                      {msg.settings.saveApiKey}
                    </button>
                  </div>
                  {apiKeySaveError && (
                    <span className="settings-error-text">{apiKeySaveError}</span>
                  )}
                </div>

                <div className="settings-card">
                  <div className="settings-card__header">
                    <div>
                      <strong>{msg.settings.mcpTitle}</strong>
                      <span>{msg.settings.mcpHint}</span>
                    </div>
                    <button
                      type="button"
                      className="settings-secondary-button"
                      onClick={checkMcpServers}
                    >
                      {msg.settings.mcpCheck}
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
                              <span className="settings-mcp-status--unsupported">{msg.settings.mcpUnsupported}</span>
                            ) : !state ? (
                              <span className="settings-mcp-item__detail">{msg.settings.mcpUnchecked}</span>
                            ) : state.loading ? (
                              <span className="settings-mcp-item__detail">{msg.settings.mcpChecking}</span>
                            ) : state.error ? (
                              <span className="settings-mcp-status--error">{state.error}</span>
                            ) : state.servers.length === 0 ? (
                              <span className="settings-mcp-item__detail">{msg.settings.mcpNone}</span>
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

            {activeSection === "phone" && <RemoteSettings />}
          </main>
        </div>

        <footer className="settings-dialog__footer">
          <span>{msg.settings.autoSaved}</span>
          <button type="button" className="settings-secondary-button" onClick={onClose}>
            {msg.settings.close}
          </button>
        </footer>
      </div>
    </div>
  );
}
