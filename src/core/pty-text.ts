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
