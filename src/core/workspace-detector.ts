import { decodePtyData } from "./pty-text";

const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
const FRAME_OVERLAP_CHARS = 400;
const PATH_SEGMENT = String.raw`[\w.-]+`;
const FILE_EXT = String.raw`(?:ts|tsx|js|jsx|rs|py|go|md|json|css|html|toml|yaml|yml|sh)`;
const ABS_UNIX = String.raw`\/(?:${PATH_SEGMENT}\/)*${PATH_SEGMENT}`;
const ABS_WIN = String.raw`[A-Za-z]:\\(?:${PATH_SEGMENT}\\)*${PATH_SEGMENT}`;
const REL_FILE = String.raw`(?:${PATH_SEGMENT}\/)+${PATH_SEGMENT}`;

const PATH_PATTERNS: RegExp[] = [
  /Switched to branch ['"]?([^'"\s]+)['"]?/,
  /On branch ([^\s]+)/,
  new RegExp(String.raw`\bcd\s+((?:${ABS_UNIX}|${ABS_WIN}))`),
  /(?:Edit(?:ing)?|Write|Wrote|Read(?:ing)?|Updated?|Modif(?:y|ied))\s+[`'"]?([^\s`'"']+)/i,
  new RegExp(
    String.raw`(?:^|\s)((?:${ABS_UNIX}|${ABS_WIN})\.${FILE_EXT})\b`,
  ),
  new RegExp(String.raw`(?:^|\s)(${REL_FILE}\.${FILE_EXT})\b`),
];

function stripAnsi(text: string): string {
  return text.includes("\x1b") ? text.replace(ANSI_PATTERN, "") : text;
}

export class WorkspaceDetector {
  private overlap = "";

  constructor(private readonly onPath: (path: string) => void) {}

  onData(data: string | Uint8Array): void {
    const clean = stripAnsi(decodePtyData(data));
    const window = this.overlap + clean;
    this.overlap = window.slice(-FRAME_OVERLAP_CHARS);

    for (const pattern of PATH_PATTERNS) {
      const match = window.match(pattern);
      const candidate = match?.[1]?.trim();
      if (!candidate || candidate.length < 2) {
        continue;
      }

      if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
        continue;
      }

      this.onPath(candidate);
      return;
    }
  }
}
