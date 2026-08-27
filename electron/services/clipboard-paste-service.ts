import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PASTE_DIR_NAME = "head-terminal-paste";
const MAX_PNG_BYTES = 25 * 1024 * 1024;
const MAX_PASTE_TEXT_CHARS = 1_048_576;
const MAX_IMAGE_EDGE = 4_096;
const MAX_PASTE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_PASTE_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_IMPORT_PATHS = 32;
const MAX_PATH_LENGTH = 16_384;
const SWEEP_INTERVAL_MS = 60_000;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp|svg|ico)$/iu;
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const CLIPBOARD_CHROME =
  /^(?:<(?:html|img|meta|body|div|span|p|head)\b|data:image\/|https?:\/\/\S+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?.*)?$)/iu;

export interface ClipboardImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toPNG(): Buffer;
}

export interface ClipboardReader {
  readText(): string;
  readImage(): ClipboardImage;
  availableFormats(): string[];
  read(format: string): string;
  readBuffer(format: string): Buffer;
}

export interface ClipboardPasteServiceOptions {
  clipboard: ClipboardReader;
  toAgentPath?: (windowsPath: string) => string;
  pasteDirectory?: string;
  now?: () => number;
}

/**
 * Turns a Windows/macOS clipboard (screenshot pixels or copied files) into
 * text the agent PTY can consume. Cursor/Claude/Codex attach an image when
 * the prompt contains a path they can read — not when the clipboard holds
 * pixels the Linux process inside WSL cannot see.
 */
export class ClipboardPasteService {
  private readonly clipboard: ClipboardReader;
  private readonly toAgentPath: (windowsPath: string) => string;
  private readonly pasteDirectory: string;
  private readonly now: () => number;
  private lastSweepAt = 0;

  constructor(options: ClipboardPasteServiceOptions) {
    this.clipboard = options.clipboard;
    this.toAgentPath = options.toAgentPath ?? ((path) => path);
    this.pasteDirectory = options.pasteDirectory ?? join(tmpdir(), PASTE_DIR_NAME);
    this.now = options.now ?? Date.now;
  }

  async readForTerminal(): Promise<string | null> {
    const files = this.readCopiedFiles();
    if (files.length > 0) {
      return formatTerminalPastePaths(files.map((path) => this.toAgentPath(path)));
    }

    const text = capPasteText(safeReadText(this.clipboard));
    const pathFromText = parseFilesystemPath(text);
    if (pathFromText) {
      return formatTerminalPastePaths([this.toAgentPath(pathFromText)]);
    }

    // Explorer Ctrl+C on a file often puts only the basename in CF_TEXT.
    // A screenshot puts HTML chrome. Neither should beat the bitmap / file.
    if (isProsePasteText(text)) {
      return text;
    }

    const imagePath = await this.saveClipboardImage();
    if (imagePath) {
      return formatTerminalPastePaths([this.toAgentPath(imagePath)]);
    }

    const trimmed = text.trim();
    return trimmed ? text : null;
  }

  async importPaths(paths: unknown): Promise<string | null> {
    const sanitized = sanitizeImportPaths(paths);
    if (sanitized.length === 0) {
      return null;
    }
    return formatTerminalPastePaths(sanitized.map((path) => this.toAgentPath(path)));
  }

  private readCopiedFiles(): string[] {
    const formats = safeFormats(this.clipboard);
    const found: string[] = [];

    const push = (path: string | null | undefined) => {
      const normalized = asCopiedFilePath(path);
      if (normalized && !found.includes(normalized)) {
        found.push(normalized);
      }
    };

    for (const path of parseUriList(safeRead(this.clipboard, "text/uri-list"))) {
      push(path);
    }
    push(parseFileUrl(safeRead(this.clipboard, "public.file-url")));
    push(parseFileNameW(safeReadBuffer(this.clipboard, "FileNameW")));
    push(parseFileNameWString(safeRead(this.clipboard, "FileNameW")));
    push(parseFileNameA(safeReadBuffer(this.clipboard, "FileName")));

    if (found.length === 0) {
      for (const format of formats) {
        if (!/file/i.test(format)) {
          continue;
        }
        push(parseFileNameW(safeReadBuffer(this.clipboard, format)));
        push(parseFileNameA(safeReadBuffer(this.clipboard, format)));
        push(parseFilesystemPath(safeRead(this.clipboard, format)));
      }
    }

    return found;
  }

  private async saveClipboardImage(): Promise<string | null> {
    const formats = safeFormats(this.clipboard);
    // Explorer file copies often list FileNameW with no image/*. Still try
    // NativeImage — isEmpty is cheap; toPNG only runs when pixels exist.
    if (formatsAreTextOnly(formats)) {
      return null;
    }
    let image: ClipboardImage;
    try {
      image = this.clipboard.readImage();
    } catch {
      return null;
    }
    if (image.isEmpty()) {
      return null;
    }
    const size = image.getSize();
    if (size.width <= 0 || size.height <= 0) {
      return null;
    }
    if (size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE) {
      return null;
    }
    const png = image.toPNG();
    if (png.byteLength === 0 || png.byteLength > MAX_PNG_BYTES) {
      return null;
    }

    const filePath = join(
      this.pasteDirectory,
      `${this.now()}-${randomUUID().slice(0, 8)}.png`,
    );
    try {
      await mkdir(this.pasteDirectory, { recursive: true });
      await writeFile(filePath, png);
    } catch {
      // Disk full (ENOSPC) or a broken volume (EIO) must not crash the paste.
      return null;
    }
    const now = this.now();
    if (now - this.lastSweepAt >= SWEEP_INTERVAL_MS) {
      this.lastSweepAt = now;
      void sweepPasteDirectory(this.pasteDirectory, now);
    }
    return filePath;
  }
}

export function isUsefulPasteText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return !CLIPBOARD_CHROME.test(trimmed);
}

/** Real prompt text, not a filename, URL, or Windows path from Explorer. */
export function isProsePasteText(text: string): boolean {
  const trimmed = text.trim();
  if (!isUsefulPasteText(trimmed)) {
    return false;
  }
  if (parseFilesystemPath(trimmed)) {
    return false;
  }
  if (IMAGE_FILE.test(trimmed) && !/\s/u.test(trimmed)) {
    return false;
  }
  return true;
}

export function parseFilesystemPath(text: string): string | null {
  const trimmed = text.trim().replace(/^["']|["']$/gu, "");
  if (!trimmed || trimmed.includes("\0")) {
    return null;
  }
  const first = trimmed.split(/\r?\n/u)[0]?.trim() ?? "";
  if (WINDOWS_PATH.test(first)) {
    return first;
  }
  if (first.startsWith("/")) {
    return first;
  }
  return null;
}

export function asCopiedFilePath(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }
  return parseFilesystemPath(path);
}

export function parseFileNameWString(raw: string): string | null {
  if (!raw) {
    return null;
  }
  return parseFilesystemPath(raw.replace(/\0+/gu, "").trim());
}

export function parseFileNameA(buffer: Buffer | null): string | null {
  if (!buffer || buffer.byteLength < 3) {
    return null;
  }
  const decoded = buffer.toString("latin1").replace(/\0+$/u, "");
  const first = decoded.split("\0")[0]?.trim() ?? "";
  return parseFilesystemPath(first);
}

function capPasteText(text: string): string {
  return text.length > MAX_PASTE_TEXT_CHARS
    ? text.slice(0, MAX_PASTE_TEXT_CHARS)
    : text;
}

export function quoteUnixPath(path: string): string {
  if (path.length === 0) {
    return path;
  }
  if (/^[A-Za-z0-9_./@%+=:,-]+$/.test(path)) {
    return path;
  }
  return `'${path.replaceAll("'", "'\\''")}'`;
}

export function formatTerminalPastePaths(paths: string[]): string {
  return paths.map(quoteUnixPath).join(" ");
}

export function parseUriList(raw: string): string[] {
  const paths: string[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const converted = parseFileUrl(trimmed);
    if (converted) {
      paths.push(converted);
    }
  }
  return paths;
}

export function parseFileUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("file:")) {
    return null;
  }
  try {
    return fileURLToPath(trimmed);
  } catch {
    try {
      const { pathname } = new URL(trimmed);
      const decoded = decodeURIComponent(pathname);
      return decoded.length > 0 ? decoded : null;
    } catch {
      return null;
    }
  }
}

export function parseFileNameW(buffer: Buffer | null): string | null {
  if (!buffer || buffer.byteLength < 2) {
    return null;
  }
  const decoded = buffer.toString("utf16le").replace(/\0+$/u, "");
  const first = decoded.split("\0")[0]?.trim() ?? "";
  return parseFilesystemPath(first);
}

export function sanitizeImportPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const paths: string[] = [];
  for (const item of value.slice(0, MAX_IMPORT_PATHS)) {
    if (typeof item !== "string" || item.length === 0 || item.length > MAX_PATH_LENGTH) {
      continue;
    }
    if (item.includes("\0")) {
      continue;
    }
    paths.push(item);
  }
  return paths;
}

export async function sweepPasteDirectory(
  directory: string,
  now = Date.now(),
  maxTotalBytes = MAX_PASTE_TOTAL_BYTES,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }

  const files: Array<{ full: string; mtimeMs: number; size: number }> = [];
  await Promise.all(
    names.map(async (name) => {
      if (!name.endsWith(".png")) {
        return;
      }
      const full = join(directory, name);
      try {
        const info = await stat(full);
        files.push({ full, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // Best-effort cleanup of leftover snips.
      }
    }),
  );

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let used = 0;
  const toDelete: string[] = [];
  for (const file of files) {
    const stale = now - file.mtimeMs > MAX_PASTE_AGE_MS;
    if (stale || used + file.size > maxTotalBytes) {
      toDelete.push(file.full);
    } else {
      used += file.size;
    }
  }
  await Promise.all(
    toDelete.map((full) => unlink(full).catch(() => undefined)),
  );
}

function formatsAreTextOnly(formats: string[]): boolean {
  if (formats.length === 0) {
    return false;
  }
  return formats.every((format) => {
    const normalized = format.toLowerCase();
    return (
      normalized.startsWith("text/") ||
      normalized === "text" ||
      normalized.includes("html")
    );
  });
}

function safeFormats(clipboard: ClipboardReader): string[] {
  try {
    return clipboard.availableFormats();
  } catch {
    return [];
  }
}

function safeReadText(clipboard: ClipboardReader): string {
  try {
    return clipboard.readText() ?? "";
  } catch {
    return "";
  }
}

function safeRead(clipboard: ClipboardReader, format: string): string {
  try {
    return clipboard.read(format) ?? "";
  } catch {
    return "";
  }
}

function safeReadBuffer(clipboard: ClipboardReader, format: string): Buffer | null {
  try {
    return clipboard.readBuffer(format);
  } catch {
    return null;
  }
}
