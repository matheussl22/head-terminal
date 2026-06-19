import { decodePtyData } from "./pty-text";

const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

const PATH_PATTERNS: RegExp[] = [
  /Switched to branch ['"]?([^'"\s]+)['"]?/,
  /On branch ([^\s]+)/,
  /(?:Edit(?:ing)?|Write|Wrote|Read(?:ing)?|Updated?|Modif(?:y|ied))\s+[`'"]?([^\s`'"']+)/i,
  /(?:^|\s)((?:\/|[A-Za-z]:\\)[\w./\\-]+\.(?:ts|tsx|js|jsx|rs|py|go|md|json|css|html|toml|yaml|yml|sh))\b/,
  /(?:^|\s)([\w./-]+\/[\w./-]+\.(?:ts|tsx|js|jsx|rs|py|go|md|json|css|html|toml|yaml|yml|sh))\b/,
];

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export class WorkspaceDetector {
  constructor(private readonly onPath: (path: string) => void) {}

  onData(data: string | Uint8Array): void {
    const clean = stripAnsi(decodePtyData(data));

    for (const pattern of PATH_PATTERNS) {
      const match = clean.match(pattern);
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
