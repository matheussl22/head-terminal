import { useEffect, useState } from "react";

import { resolveDefaultCwd } from "../../core/agent-launcher";
import { fetchMcpServers, type McpServerStatus } from "../../core/mcp-bridge";
import { loadOpenAiApiKey, saveOpenAiApiKey } from "../../core/ui-preferences";
import { buildAgentProfiles } from "../../config/agents";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

function statusClass(status: string): string {
  if (status.includes("✔")) return "settings-mcp-status--ok";
  if (status.includes("✘")) return "settings-mcp-status--error";
  return "settings-mcp-status--pending";
}

// Apenas a Claude Code CLI tem um comando de MCP verificado (`claude mcp
// list`). Cursor e Codex não têm equivalente confirmado — revisar quando
// expuserem algo parecido.
const AGENTS_WITH_MCP_SUPPORT = new Set(["claude"]);

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setApiKey(loadOpenAiApiKey());
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setMcpLoading(true);
    setMcpError(null);

    let cancelled = false;
    resolveDefaultCwd()
      .then(fetchMcpServers)
      .then((payload) => {
        if (cancelled) return;
        setMcpServers(payload.servers);
        setMcpError(payload.error);
      })
      .catch((err) => {
        if (cancelled) return;
        setMcpError(String(err));
      })
      .finally(() => {
        if (!cancelled) setMcpLoading(false);
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
            .map((profile) => (
              <li key={profile.id} className="settings-mcp-item">
                <span className="settings-mcp-item__name">{profile.label}</span>
                {!AGENTS_WITH_MCP_SUPPORT.has(profile.id) ? (
                  <span className="settings-mcp-status--unsupported">
                    Não suportado
                  </span>
                ) : mcpLoading ? (
                  <span className="settings-mcp-item__detail">Verificando…</span>
                ) : mcpError ? (
                  <span className="settings-mcp-status--error">{mcpError}</span>
                ) : mcpServers.length === 0 ? (
                  <span className="settings-mcp-item__detail">
                    Nenhum MCP server configurado
                  </span>
                ) : (
                  <span className="settings-mcp-item__detail">
                    {mcpServers.map((server) => (
                      <span
                        key={server.name}
                        className={`${statusClass(server.status)}`}
                        title={server.target}
                      >
                        {server.name} ({server.status}){" "}
                      </span>
                    ))}
                  </span>
                )}
              </li>
            ))}
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
