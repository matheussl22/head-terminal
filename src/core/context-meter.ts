import { decodePtyData } from "./pty-text";

const RECENT_TEXT_LIMIT = 600;

// Avisos de contexto restante impressos por agents (Claude Code e afins).
// ponytail: casa texto plano; ANSI no meio das palavras quebra o match —
// suficiente para os avisos reais, revisar se algum agent colorir palavra a palavra.
// Falso positivo conhecido: ghost text do zsh-autosuggestions ecoando um comando
// antigo que mencione "context ...%"; autocorrige na próxima leitura real.
const CONTEXT_PATTERNS = [
  /context left until auto-compact:\s*(\d{1,3})\s*%/gi,
  /context low \((\d{1,3})\s*% remaining\)/gi,
  /(\d{1,3})\s*%\s*(?:context\s+)?(?:left|remaining|restante)/gi,
];

/** Última menção de "% de contexto restante" no texto, ou null. */
export function extractContextPercent(text: string): number | null {
  let best: { index: number; value: number } | null = null;

  for (const pattern of CONTEXT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (value <= 100 && (!best || match.index >= best.index)) {
        best = { index: match.index, value };
      }
    }
  }

  return best?.value ?? null;
}

export function contextColor(percent: number): string {
  if (percent < 25) {
    return "var(--status-error)";
  }
  if (percent < 50) {
    return "var(--status-waiting)";
  }
  return "var(--status-idle)";
}

export class ContextMeter {
  private recentText = "";
  private lastPercent: number | null = null;

  constructor(private readonly onPercent: (percent: number) => void) {}

  onData(data: string | Uint8Array): void {
    this.recentText = (this.recentText + decodePtyData(data)).slice(
      -RECENT_TEXT_LIMIT,
    );

    const percent = extractContextPercent(this.recentText);
    if (percent !== null && percent !== this.lastPercent) {
      this.lastPercent = percent;
      this.onPercent(percent);
    }
  }
}
