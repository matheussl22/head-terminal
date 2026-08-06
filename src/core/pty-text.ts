const textDecoder = new TextDecoder();

export function decodePtyData(data: string | Uint8Array): string {
  return typeof data === "string" ? data : textDecoder.decode(data);
}

// SGR mouse report: CSI < Cb ; Cx ; Cy M/m. Cb bit 5 (32) marks a motion
// event; bits 0-1 == 3 means no button is held. That combination is a bare
// hover (mouse moved, nothing pressed) — CLIs that enable mouse tracking
// (Claude Code, Cursor Agent) redraw on every one of these, which the
// activity detector then misreads as "working". Real clicks and drags keep
// their button bits set and still get forwarded.
const SGR_MOUSE_REPORT = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;

export function isBareMouseHoverReport(data: string): boolean {
  const match = SGR_MOUSE_REPORT.exec(data);
  if (!match) {
    return false;
  }
  const cb = Number(match[1]);
  return (cb & 32) !== 0 && (cb & 3) === 3;
}

// DECSET 1004 focus-in/out report. xterm.js sends this the moment its
// hidden textarea gains/loses DOM focus — i.e. every time the user clicks a
// pane to switch focus between splits, completely independent of whether
// anything is actually happening in it. Head-terminal already shows the
// focused pane with its own chrome (border highlight), so forwarding this
// upstream buys nothing — but focus-tracking CLIs (Claude Code, Cursor
// Agent) redraw their whole screen on every one, which the activity
// detector then misreads as "working" (see isBareMouseHoverReport above —
// same failure mode, different escape sequence).
const FOCUS_REPORT = /^\x1b\[[IO]$/;

export function isFocusReport(data: string): boolean {
  return FOCUS_REPORT.test(data);
}
