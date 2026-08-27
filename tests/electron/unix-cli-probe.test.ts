import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { HT_UNIX_CMD_FN, UNIX_USER_BIN_PATH_EXPORT, WINDOWS_INTEROP_CLI_GLOB } from "../../src/core/unix-cli-probe";

function wslBash(script: string): string {
  return execFileSync("wsl.exe", ["-e", "bash", "-lc", script], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
}

describe("ht_unix_cmd", () => {
  it("rejects Windows batch files and /mnt/<drive>/ paths", () => {
    expect(WINDOWS_INTEROP_CLI_GLOB).toContain("*.cmd");
    expect(WINDOWS_INTEROP_CLI_GLOB).toContain("/mnt/[a-z]/*");
    expect(HT_UNIX_CMD_FN).toContain("ht_unix_cmd()");
  });

  it.runIf(process.platform === "win32")(
    "rejects a .cmd on PATH and accepts a Unix script, inside WSL",
    () => {
      const script = `
        ${HT_UNIX_CMD_FN}
        tmp=$(mktemp -d)
        trap '/usr/bin/rm -rf "$tmp"' EXIT
        printf '%s\\n' '@echo off' > "$tmp/cursor-agent.cmd"
        /usr/bin/chmod +x "$tmp/cursor-agent.cmd"
        export PATH="$tmp:/usr/bin:/bin"
        if ht_unix_cmd cursor-agent; then echo CMD_ACCEPTED; else echo CMD_REJECTED; fi
        /usr/bin/rm -f "$tmp/cursor-agent.cmd"
        printf '%s\\n' '#!/bin/sh' 'echo ok' > "$tmp/cursor-agent"
        /usr/bin/chmod +x "$tmp/cursor-agent"
        if ht_unix_cmd cursor-agent; then echo UNIX_ACCEPTED; else echo UNIX_REJECTED; fi
        p='/mnt/c/Users/mathe/AppData/Local/cursor-agent/cursor-agent.cmd'
        p=$(printf %s "$p" | tr '[:upper:]' '[:lower:]')
        case "$p" in ${WINDOWS_INTEROP_CLI_GLOB}) echo INTEROP_REJECTED ;; *) echo INTEROP_ACCEPTED ;; esac
      `;
      const out = wslBash(script);
      expect(out).toContain("CMD_REJECTED");
      expect(out).not.toContain("CMD_ACCEPTED");
      expect(out).toContain("UNIX_ACCEPTED");
      expect(out).not.toContain("UNIX_REJECTED");
      expect(out).toContain("INTEROP_REJECTED");
      expect(out).not.toContain("INTEROP_ACCEPTED");
    },
    20_000,
  );

  it.runIf(process.platform === "win32")(
    "with ~/.local/bin on PATH, finds Linux cursor-agent instead of the Windows .cmd",
    () => {
      const script = `
        ${UNIX_USER_BIN_PATH_EXPORT}
        ${HT_UNIX_CMD_FN}
        p=$(command -v cursor-agent || true)
        echo "resolved=$p"
        if ht_unix_cmd cursor-agent; then echo FILTER=OK; else echo FILTER=REJECT; fi
      `;
      const out = wslBash(script);
      expect(out).toContain("FILTER=OK");
      expect(out).not.toMatch(/resolved=.*\.cmd/u);
      expect(out).not.toMatch(/resolved=\/mnt\/[a-z]\//u);
    },
    20_000,
  );
});
