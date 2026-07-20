function localeEncodingSuffix(): string {
  if (typeof navigator === "undefined") {
    return "UTF-8";
  }

  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.platform;

  return /linux/i.test(platform) ? "utf8" : "UTF-8";
}

function toPosixLocale(languageTag: string): string {
  const normalized = languageTag.trim().replace("-", "_");
  const encoding = localeEncodingSuffix();
  const fallback = `pt_BR.${encoding}`;

  if (!normalized) {
    return fallback;
  }

  if (normalized.includes(".")) {
    return normalized;
  }

  return `${normalized}.${encoding}`;
}

export function resolvePtyLocale(): string {
  if (typeof navigator !== "undefined" && navigator.language) {
    return toPosixLocale(navigator.language);
  }

  return toPosixLocale("pt-BR");
}

export function buildPtyEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const locale = resolvePtyLocale();

  return {
    LANG: locale,
    LC_ALL: locale,
    LC_CTYPE: locale,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    ...overrides,
  };
}
