import { useState } from "react";

import { IconServer } from "../ui/Icons";
import { McpServersModal } from "./McpServersModal";

interface McpServersButtonProps {
  cwd: string;
}

export function McpServersButton({ cwd }: McpServersButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="terminal-pane-header__mcp"
        title="MCP servers conectados"
        aria-label="MCP servers conectados"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <IconServer />
      </button>
      <McpServersModal open={open} cwd={cwd} onClose={() => setOpen(false)} />
    </>
  );
}
