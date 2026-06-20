import { useEffect, useState } from "react";

import { resolveDefaultCwd } from "../../core/agent-launcher";
import { fetchMcpServers, type McpServerStatus } from "../../core/mcp-bridge";
import { loadOpenAiApiKey, saveOpenAiApiKey } from "../../core/ui-preferences";
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

// Claude Code (`claude mcp list`) e Cursor (`cursor-agent mcp list`) têm
// comandos de MCP verificados. Codex CLI não está instalada e não tem
// equivalente confirmado — revisar quando expuser algo parecido.
const AGENTS_WITH_MCP_SUPPORT = new Set(["claude", "cursor"]);

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [mcpByAgent, setMcpByAgent] = useState<Record<string, McpAgentState>>({});

  useEffect(() => {
    if (open) {
      setApiKey(loadOpenAiApiKey());
    }
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
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-..."
            autoComplete="off"
          />
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
            onClick={() => {
              saveOpenAiApiKey(apiKey);
              onClose();
            }}
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
