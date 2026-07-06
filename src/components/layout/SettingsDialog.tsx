import { useEffect, useState } from "react";

import { resolveDefaultCwd } from "../../core/agent-launcher";
import { logEvent } from "../../core/logger";
import { fetchMcpServers, type McpServerStatus } from "../../core/mcp-bridge";
import { persistOpenAiApiKey, resolveOpenAiApiKey } from "../../core/openai-credentials";
import {
  loadCopyOnSelect,
  loadFontSize,
  loadRendererPreference,
  saveCopyOnSelect,
  saveFontSize,
  saveRendererPreference,
  type TerminalRenderer,
} from "../../core/ui-preferences";
import { buildAgentProfiles } from "../../config/agents";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

interface McpAgentState {
  servers: McpServerStatus[];
  error: string | null;
  loading: boolean;
}

function statusClass(status: string): string {
  if (status.includes("✔")) return "settings-mcp-status--ok";
  if (status.includes("✘")) return "settings-mcp-status--error";
  return "settings-mcp-status--pending";
}

const AGENTS_WITH_MCP_SUPPORT = new Set(["claude", "cursor"]);

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [apiKeyEdited, setApiKeyEdited] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [apiKeySaveError, setApiKeySaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [fontSize, setFontSize] = useState(12);
  const [renderer, setRenderer] = useState<TerminalRenderer>("auto");
  const [copyOnSelect, setCopyOnSelect] = useState(false);
  const [mcpByAgent, setMcpByAgent] = useState<Record<string, McpAgentState>>({});

  useEffect(() => {
    if (!open) {
      return;
    }

    setFontSize(loadFontSize());
    setRenderer(loadRendererPreference());
    setCopyOnSelect(loadCopyOnSelect());
    setApiKeySaveError(null);
    setApiKeyEdited(false);
    setApiKey("");

    void resolveOpenAiApiKey().then((stored) => {
      setHasStoredKey(Boolean(stored));
    });
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    const agentsToCheck = Object.values(buildAgentProfiles()).filter((profile) =>
      AGENTS_WITH_MCP_SUPPORT.has(profile.id),
    );

    setMcpByAgent(
      Object.fromEntries(
        agentsToCheck.map((profile) => [
          profile.id,
          { servers: [], error: null, loading: true },
        ]),
      ),
    );

    resolveDefaultCwd().then((cwd) => {
      for (const profile of agentsToCheck) {
        fetchMcpServers(cwd, profile.id)
          .then((payload) => {
            if (cancelled) return;
            setMcpByAgent((prev) => ({
              ...prev,
              [profile.id]: {
                servers: payload.servers,
                error: payload.error,
                loading: false,
              },
            }));
          })
          .catch((err) => {
            if (cancelled) return;
            setMcpByAgent((prev) => ({
              ...prev,
              [profile.id]: { servers: [], error: String(err), loading: false },
            }));
          });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open]);

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

  if (!open) {
    return null;
  }

  return (
    <div className="create-session-backdrop" onClick={onClose}>
      <div
        className="create-session-dialog"
        role="dialog"
        aria-label="Configurações"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="create-session-dialog__title">Configurações</h2>

        <label className="create-session-dialog__field">
          <span>Chave da API OpenAI</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => {
              setApiKeyEdited(true);
              setApiKey(event.target.value);
            }}
            placeholder={hasStoredKey ? "Chave configurada — digite para substituir" : "sk-..."}
            autoComplete="off"
          />
          {hasStoredKey && !apiKeyEdited && (
            <span className="settings-mcp-status--ok">Chave configurada</span>
          )}
          {apiKeySaveError && (
            <span className="settings-mcp-status--error">
              Não foi possível salvar no keyring do sistema ({apiKeySaveError}).
              A chave foi mantida localmente e ainda funciona.
            </span>
          )}
        </label>

        <label className="create-session-dialog__field">
          <span>Tamanho da fonte do terminal</span>
          <input
            type="number"
            min={8}
            max={24}
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value))}
          />
        </label>

        <label className="create-session-dialog__field">
          <span>Renderer do terminal</span>
          <select
            value={renderer}
            onChange={(event) =>
              setRenderer(event.target.value as TerminalRenderer)
            }
          >
            <option value="auto">Automático (WebGL com fallback)</option>
            <option value="webgl">WebGL</option>
            <option value="dom">DOM (mais compatível)</option>
          </select>
        </label>

        <label className="create-session-dialog__field create-session-dialog__field--inline">
          <input
            type="checkbox"
            checked={copyOnSelect}
            onChange={(event) => setCopyOnSelect(event.target.checked)}
          />
          <span>Copiar ao selecionar</span>
        </label>

        <h3 className="create-session-dialog__title">MCP servers</h3>
        <ul className="settings-mcp-list">
          {Object.values(buildAgentProfiles())
            .filter((profile) => profile.id !== "shell")
            .map((profile) => {
              const state = mcpByAgent[profile.id];

              return (
                <li key={profile.id} className="settings-mcp-item">
                  <span className="settings-mcp-item__name">{profile.label}</span>
                  {!AGENTS_WITH_MCP_SUPPORT.has(profile.id) ? (
                    <span className="settings-mcp-status--unsupported">
                      Não suportado
                    </span>
                  ) : !state || state.loading ? (
                    <span className="settings-mcp-item__detail">Verificando…</span>
                  ) : state.error ? (
                    <span className="settings-mcp-status--error">{state.error}</span>
                  ) : state.servers.length === 0 ? (
                    <span className="settings-mcp-item__detail">
                      Nenhum MCP server configurado
                    </span>
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

        <div className="create-session-dialog__actions">
          <button type="button" className="agent-toolbar__button--ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="agent-toolbar__button"
            disabled={saving}
            onClick={() => {
              void (async () => {
                setSaving(true);
                saveFontSize(fontSize);
                saveRendererPreference(renderer);
                saveCopyOnSelect(copyOnSelect);

                try {
                  if (apiKeyEdited) {
                    await persistOpenAiApiKey(apiKey);
                    setHasStoredKey(Boolean(apiKey.trim()));
                  }
                  setSaving(false);
                  onClose();
                } catch (error) {
                  // persistOpenAiApiKey already mirrored to localStorage; surface
                  // keyring errors so the user knows persistence may be partial.
                  const message =
                    error instanceof Error ? error.message : String(error);
                  logEvent("error", "settings.api_key_save_failed", {
                    message,
                  });
                  setApiKeySaveError(
                    `Chave salva localmente, mas o cofre do sistema falhou: ${message}`,
                  );
                  setSaving(false);
                }
              })();
            }}
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
