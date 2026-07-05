import { useEffect, useState } from "react";

import { findAgentInstructionFile } from "../core/agent-instructions";

export function useAgentInstructionFile(
  repoRoot: string | null | undefined,
): string | null {
  const [filename, setFilename] = useState<string | null>(null);

  useEffect(() => {
    if (!repoRoot) {
      setFilename(null);
      return;
    }

    let cancelled = false;

    void findAgentInstructionFile(repoRoot).then((result) => {
      if (!cancelled) {
        setFilename(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  return filename;
}
