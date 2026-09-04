import type { PersistedWorkspace } from "./session-persistence";
import { mapPaneNodes } from "./session-layout";
import { legacyPosixToWindowsPath } from "./path-utils";

/**
 * Workspaces saved while Windows panes ran inside WSL carry POSIX folders:
 * `/mnt/c/...` for a Windows drive, `/home/<user>/...` for the distro's own
 * disk. Native panes need `C:\...`; the first kind translates exactly, the
 * second has no Windows equivalent and falls back to the default folder
 * rather than failing to open. Off Windows this is the identity.
 */
export function migrateWorkspaceCwds(
  workspace: PersistedWorkspace,
  options: { isWindows: boolean; fallbackCwd: string },
): PersistedWorkspace {
  if (!options.isWindows) {
    return workspace;
  }

  let changed = false;
  const migrate = (cwd: string): string => {
    if (!cwd.startsWith("/")) {
      return cwd;
    }
    changed = true;
    return legacyPosixToWindowsPath(cwd) ?? options.fallbackCwd;
  };

  const sessions = workspace.sessions.map((session) => ({
    ...session,
    cwd: migrate(session.cwd),
    layout: mapPaneNodes(session.layout, (pane) =>
      pane.cwd === undefined ? pane : { ...pane, cwd: migrate(pane.cwd) },
    ),
  }));

  return changed ? { ...workspace, sessions } : workspace;
}
