import { useEffect, useState } from "react";

import { fetchMcpServers, type McpServerStatus } from "../../core/mcp-bridge";

interface McpServersModalProps {
  open: boolean;
  cwd: string;
  onClose: () => void;
}

function statusClass(status: string): string {
  if (status.includes("✔")) return "mcp-servers-modal__status--ok";
  if (status.includes("✘")) return "mcp-servers-modal__status--error";
  return "mcp-servers-modal__status--pending";
}

export function McpServersModal({ open, cwd, onClose }: McpServersModalProps) {
  const [loading, setLoading] = useState(false);
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setLoading(true);
    setError(null);

    let cancelled = false;
    fetchMcpServers(cwd)
      .then((payload) => {
        if (cancelled) return;
        setServers(payload.servers);
        setError(payload.error);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, cwd]);

  if (!open) {
    return null;
  }

  return (
    <div className="create-session-backdrop" onClick={onClose}>
      <div
        className="create-session-dialog"
        role="dialog"
        aria-label="MCP servers conectados"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="create-session-dialog__title">MCP servers</h2>

        {loading && <p className="mcp-servers-modal__hint">Verificando…</p>}

        {!loading && error && (
          <p className="mcp-servers-modal__hint">{error}</p>
        )}

        {!loading && !error && servers.length === 0 && (
          <p className="mcp-servers-modal__hint">
            Nenhum MCP server configurado.
          </p>
        )}

        {!loading && !error && servers.length > 0 && (
          <ul className="mcp-servers-modal__list">
            {servers.map((server) => (
              <li key={server.name} className="mcp-servers-modal__item">
                <span className="mcp-servers-modal__name">{server.name}</span>
                <span className="mcp-servers-modal__target">{server.target}</span>
                <span className={`mcp-servers-modal__status ${statusClass(server.status)}`}>
                  {server.status}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="create-session-dialog__actions">
          <button type="button" className="agent-toolbar__button--ghost" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
