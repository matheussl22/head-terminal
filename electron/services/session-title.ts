/**
 * Turns the opening message of a transcript into a name a pane header can
 * show. The raw prompt is a paragraph — greeting, hedging, a pasted url, then
 * the actual task — so what gets kept is the first sentence with that
 * scaffolding cut away, short enough to read at a glance instead of dying in
 * an ellipsis.
 */

export const TITLE_MAX_LENGTH = 56;
// A sentence shorter than this ("Olha só.", "Preciso de uma ajuda.") names
// nothing on its own, so the next one is pulled in too.
const TITLE_MIN_LENGTH = 18;
const FILLER_MAX_PASSES = 4;
// Path tail a url can keep before it is worth collapsing the middle.
const URL_PATH_MAX_LENGTH = 16;

/** Politeness, hedging and "please do X" wrappers: everything before the verb
 * that says what the conversation is about. Stripped in a loop, since they
 * stack ("Tá, eu preciso ver se…"). */
const FILLER_PREFIX = new RegExp(
  `^(?:${[
    // Clock stamp a pasted chat log opens with ("[14:26] Fulano: …"). Only the
    // time shape, so a real tag like "[feat/HOLD-1324]" survives.
    "\\[(?:\\p{L}+\\s+)?\\d{1,2}:\\d{2}(?::\\d{2})?\\]\\s*",
    // Greetings, which are never anything else. `\b` can't close these: it is
    // ASCII-only, so it never fires between "olá" and what follows it.
    "(?:oi|olá|ola|opa|e aí|e ai|bom dia|boa tarde|boa noite|hey|hi|hello|blz)(?![\\p{L}\\p{N}])[\\s,.!:—-]*",
    // Words that only read as throat-clearing when a pause follows them:
    // "Tá, preciso…" opens with filler, "Olha esse arquivo" does not.
    "(?:tá|ta|então|entao|olha|fala|cara|beleza|ok|okay)\\s*[,.!:—-]+\\s*",
    "(?:por favor|please)[\\s,]*",
    "(?:eu\\s+)?(?:preciso|queria|gostaria|quero)\\s+que\\s+(?:você|voce|vc|tu)\\s+",
    "(?:eu\\s+)?(?:preciso|quero|queria)\\s+(?!de\\b)",
    "me\\s+(?:ajuda|ajude)\\s+(?:a|com|no|na)\\s+",
    "(?:você|voce|vc)\\s+(?:consegue|pode|poderia)\\s+",
    // Bare "consegue/pode" only when an infinitive follows, so "pode ser que…"
    // keeps its subject.
    "(?:consegue|conseguiria|pode|poderia)\\s+(?=\\p{L}*r\\s)",
    "(?:can|could)\\s+you\\s+(?:please\\s+)?",
    "i\\s+(?:need|want)\\s+you\\s+to\\s+",
    "help\\s+me\\s+(?:to\\s+)?",
  ].join("|")})`,
  "iu",
);

// Sentence terminators only count when a space (or the end) follows, which is
// what keeps "Qwen3.8-27B" and "example.com/a.b" in one piece.
const SENTENCE_END = /[.!?…]+(?=\s|$)/u;
const URL = /\bhttps?:\/\/(?:www\.)?([^\s/]+)(\/\S*)?/giu;
// Absolute paths with at least three segments: enough that dropping the
// middle saves more than it costs.
const DEEP_PATH = /(?<![\w~])\/(?:[\w.@%+-]+\/){2,}([\w.@%+-]+)/gu;

function shortenUrl(host: string, path: string | undefined): string {
  if (!path || path.length <= URL_PATH_MAX_LENGTH) {
    return `${host}${path ?? ""}`;
  }
  const last = path.split("/").filter(Boolean).pop();
  return last ? `${host}/…/${last}` : host;
}

/** Urls and deep paths eat a title's whole budget while saying one thing.
 * Host plus last segment says the same thing in a fraction of the room. */
function compactReferences(text: string): string {
  return text
    .replace(URL, (_match, host: string, path?: string) => shortenUrl(host, path))
    .replace(DEEP_PATH, "…/$1");
}

function stripFiller(text: string): string {
  let result = text;
  for (let pass = 0; pass < FILLER_MAX_PASSES; pass += 1) {
    const stripped = result.replace(FILLER_PREFIX, "").trimStart();
    // Nothing but filler: the original at least says something.
    if (!stripped || stripped === result) break;
    result = stripped;
  }
  return result;
}

function firstSentences(text: string): string {
  let kept = "";
  let rest = text;
  while (rest) {
    const match = SENTENCE_END.exec(rest);
    if (!match) {
      kept = `${kept} ${rest}`.trim();
      break;
    }
    const end = match.index + match[0].length;
    kept = `${kept} ${rest.slice(0, end)}`.trim();
    rest = rest.slice(end).trimStart();
    if (kept.length >= TITLE_MIN_LENGTH) break;
  }
  return kept;
}

function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const lastSpace = head.lastIndexOf(" ");
  // Snapping back to a word boundary is only worth it when it doesn't throw
  // away half the title — a single long token has nowhere to snap to.
  const body = lastSpace > max * 0.6 ? head.slice(0, lastSpace) : head;
  return `${body.replace(/[\s\p{P}]+$/u, "")}…`;
}

export function summarizeTitle(raw: string): string {
  const summary = firstSentences(stripFiller(compactReferences(raw.trim())));
  // A closing "?" or "!" is part of what the conversation is; a period is not.
  return truncateAtWord(summary.replace(/\s*\.+$/u, "").trim(), TITLE_MAX_LENGTH);
}
