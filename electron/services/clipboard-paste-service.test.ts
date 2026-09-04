import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ClipboardPasteService,
  formatTerminalPastePaths,
  isUsefulPasteText,
  parseFileNameW,
  parseFilesystemPath,
  parseUriList,
  quoteUnixPath,
  sweepPasteDirectory,
  type ClipboardImage,
  type ClipboardReader,
} from "./clipboard-paste-service";

/** One `toAgentPath` flavour: `C:\x\y` → `/mnt/c/x/y`, POSIX input untouched. */
function toPosixPath(windows: string): string {
  const drive = /^([A-Za-z]):(?:\\|\/)(.*)$/u.exec(windows);
  if (drive) {
    const rest = drive[2].replaceAll("\\", "/");
    return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
  }
  return windows.replaceAll("\\", "/");
}

/** 1×1 PNG (red pixel). */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function fakeImage(options?: {
  empty?: boolean;
  width?: number;
  height?: number;
  png?: Buffer;
}): ClipboardImage {
  const width = options?.width ?? 1;
  const height = options?.height ?? 1;
  return {
    isEmpty: () => options?.empty === true,
    getSize: () => ({ width, height }),
    toPNG: () => options?.png ?? TINY_PNG,
  };
}

function fakeClipboard(overrides: Partial<ClipboardReader> = {}): ClipboardReader {
  return {
    readText: () => "",
    readImage: () => fakeImage({ empty: true }),
    availableFormats: () => [],
    read: () => "",
    readBuffer: () => Buffer.alloc(0),
    ...overrides,
  };
}

describe("clipboard paste helpers", () => {
  it("quotes only paths that would split in a POSIX shell", () => {
    expect(quoteUnixPath("/mnt/c/Temp/snip.png")).toBe("/mnt/c/Temp/snip.png");
    expect(quoteUnixPath("/mnt/c/Users/John Doe/snip.png"))
      .toBe("'/mnt/c/Users/John Doe/snip.png'");
    expect(quoteUnixPath("/tmp/it's.png")).toBe("'/tmp/it'\\''s.png'");
    expect(formatTerminalPastePaths(["/a.png", "/b c.png"]))
      .toBe("/a.png '/b c.png'");
  });

  it("treats screenshot chrome as not useful so the bitmap can win", () => {
    expect(isUsefulPasteText("")).toBe(false);
    expect(isUsefulPasteText("   ")).toBe(false);
    expect(isUsefulPasteText("<html><img src='blob:0'>")).toBe(false);
    expect(isUsefulPasteText("https://cdn.example/shot.png")).toBe(false);
    expect(isUsefulPasteText("data:image/png;base64,aaa")).toBe(false);
    expect(isUsefulPasteText("look at this screenshot")).toBe(true);
    expect(isUsefulPasteText("https://github.com/foo/bar")).toBe(true);
  });

  it("parses Explorer and file-url clipboard payloads", () => {
    const windows = String.raw`C:\Users\mathe\shot.png`;
    expect(parseFileNameW(Buffer.from(`${windows}\0`, "utf16le"))).toBe(windows);
    expect(parseUriList("file:///tmp/shot.png\n# ignore\n")).toEqual(["/tmp/shot.png"]);
    expect(parseFilesystemPath(String.raw`"C:\Users\mathe\shot.png"`)).toBe(windows);
    expect(parseFilesystemPath("photo.png")).toBeNull();
  });
});

describe("ClipboardPasteService", () => {
  it("saves a clipboard screenshot as PNG and returns the WSL path", async () => {
    const directory = join(tmpdir(), `ht-paste-${Date.now()}`);
    cleanup.push(directory);
    const service = new ClipboardPasteService({
      clipboard: fakeClipboard({
        availableFormats: () => ["image/png"],
        readImage: () => fakeImage(),
      }),
      pasteDirectory: directory,
      toAgentPath: toPosixPath,
      now: () => 1_700_000_000_000,
    });

    const pasted = await service.readForTerminal();
    expect(pasted).toMatch(/\.png$/);
    const agentPath = pasted!.replace(/^'|'$/g, "");
    const filename = agentPath.split("/").pop()!;
    const written = await readFile(join(directory, filename));
    expect(written.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(written.equals(TINY_PNG)).toBe(true);
    expect(agentPath).toBe(toPosixPath(join(directory, filename)));
  });

  it("prefers copied file paths over a bitmap preview", async () => {
    const directory = join(tmpdir(), `ht-paste-${Date.now()}-files`);
    cleanup.push(directory);
    const original = String.raw`D:\shots\bug.png`;
    const service = new ClipboardPasteService({
      clipboard: fakeClipboard({
        availableFormats: () => ["FileNameW", "image/png"],
        readBuffer: () => Buffer.from(`${original}\0`, "utf16le"),
        readImage: () => fakeImage(),
      }),
      pasteDirectory: directory,
      toAgentPath: toPosixPath,
    });

    expect(await service.readForTerminal()).toBe("/mnt/d/shots/bug.png");
  });

  it("does not paste ANSI FileName bytes decoded as UTF-16", async () => {
    const original = String.raw`C:\Users\mathe\Pictures\shot.png`;
    const service = new ClipboardPasteService({
      clipboard: fakeClipboard({
        availableFormats: () => ["FileNameW", "FileName"],
        readBuffer: (format) => {
          if (format === "FileNameW") {
            return Buffer.from(`${original}\0`, "utf16le");
          }
          if (format === "FileName") {
            return Buffer.from(`${original}\0`, "latin1");
          }
          return Buffer.alloc(0);
        },
      }),
      toAgentPath: toPosixPath,
    });

    expect(await service.readForTerminal()).toBe(
      "/mnt/c/Users/mathe/Pictures/shot.png",
    );
  });

  it("translates a Windows path in CF_TEXT when FileNameW is missing", async () => {
    const service = new ClipboardPasteService({
      clipboard: fakeClipboard({
        availableFormats: () => ["text/plain"],
        readText: () => String.raw`C:\Users\mathe\Pictures\bug.png`,
      }),
      toAgentPath: toPosixPath,
    });

    expect(await service.readForTerminal()).toBe("/mnt/c/Users/mathe/Pictures/bug.png");
  });

  it("reads FileNameW from clipboard.read when readBuffer is empty", async () => {
    const original = String.raw`C:\Users\mathe\Desktop\shot.png`;
    const service = new ClipboardPasteService({
      clipboard: fakeClipboard({
        availableFormats: () => ["FileNameW"],
        read: (format) => (format === "FileNameW" ? `${original}\0` : ""),
      }),
      toAgentPath: toPosixPath,
    });

    expect(await service.readForTerminal()).toBe("/mnt/c/Users/mathe/Desktop/shot.png");
  });

  it("saves the bitmap when Explorer only put the filename in CF_TEXT", async () => {
    const directory = join(tmpdir(), `ht-paste-${Date.now()}-basename`);
    cleanup.push(directory);
    const service = new ClipboardPasteService({
      clipboard: fakeClipboard({
        readText: () => "bug.png",
        availableFormats: () => ["text/plain", "image/png"],
        readImage: () => fakeImage(),
      }),
      pasteDirectory: directory,
      toAgentPath: toPosixPath,
    });

    const pasted = await service.readForTerminal();
    expect(pasted).toMatch(/\.png$/);
    expect(pasted).not.toBe("bug.png");
  });

  it("pastes real text instead of a companion bitmap", async () => {
    const service = new ClipboardPasteService({
      clipboard: fakeClipboard({
        readText: () => "fix the login button",
        readImage: () => fakeImage(),
      }),
      pasteDirectory: join(tmpdir(), "ht-paste-unused"),
    });

    expect(await service.readForTerminal()).toBe("fix the login button");
  });

  it("saves the bitmap when the only text is HTML from the snipping tool", async () => {
    const directory = join(tmpdir(), `ht-paste-${Date.now()}-html`);
    cleanup.push(directory);
    const service = new ClipboardPasteService({
      clipboard: fakeClipboard({
        readText: () => "<html>\r\n<body><!--StartFragment--><img src=\"x\"></body></html>",
        availableFormats: () => ["text/html", "image/png"],
        readImage: () => fakeImage(),
      }),
      pasteDirectory: directory,
      toAgentPath: (path) => path.replaceAll("\\", "/"),
    });

    const pasted = await service.readForTerminal();
    expect(pasted).toMatch(/\.png$/);
  });

  it("returns null when the clipboard is empty", async () => {
    const service = new ClipboardPasteService({
      clipboard: fakeClipboard(),
      pasteDirectory: join(tmpdir(), "ht-paste-empty"),
    });
    expect(await service.readForTerminal()).toBeNull();
  });

  it("skips image encode when available formats are text-only", async () => {
    const readImage = vi.fn(() => fakeImage());
    const service = new ClipboardPasteService({
      clipboard: fakeClipboard({
        availableFormats: () => ["text/plain", "text/html"],
        readImage,
      }),
      pasteDirectory: join(tmpdir(), "ht-paste-text-only"),
    });

    expect(await service.readForTerminal()).toBeNull();
    expect(readImage).not.toHaveBeenCalled();
  });

  it("caps pasted text at 1 MiB", async () => {
    const oversized = `fix ${"a".repeat(1_048_576)}`;
    const service = new ClipboardPasteService({
      clipboard: fakeClipboard({
        readText: () => oversized,
      }),
      pasteDirectory: join(tmpdir(), "ht-paste-cap"),
    });

    const pasted = await service.readForTerminal();
    expect(pasted).toHaveLength(1_048_576);
    expect(pasted?.startsWith("fix ")).toBe(true);
  });

  it("skips PNG encode when the bitmap is larger than 4K on either edge", async () => {
    const toPNG = vi.fn(() => TINY_PNG);
    const service = new ClipboardPasteService({
      clipboard: fakeClipboard({
        availableFormats: () => ["image/png"],
        readImage: () => ({
          isEmpty: () => false,
          getSize: () => ({ width: 8192, height: 4320 }),
          toPNG,
        }),
      }),
      pasteDirectory: join(tmpdir(), "ht-paste-huge"),
    });

    expect(await service.readForTerminal()).toBeNull();
    expect(toPNG).not.toHaveBeenCalled();
  });

  it("still encodes a 4K screenshot", async () => {
    const directory = join(tmpdir(), `ht-paste-${Date.now()}-4k`);
    cleanup.push(directory);
    const toPNG = vi.fn(() => TINY_PNG);
    const service = new ClipboardPasteService({
      clipboard: fakeClipboard({
        availableFormats: () => ["image/png"],
        readImage: () => ({
          isEmpty: () => false,
          getSize: () => ({ width: 3840, height: 2160 }),
          toPNG,
        }),
      }),
      pasteDirectory: directory,
      toAgentPath: (path) => path.replaceAll("\\", "/"),
    });

    const pasted = await service.readForTerminal();
    expect(pasted).toMatch(/\.png$/);
    expect(toPNG).toHaveBeenCalledOnce();
  });

  it("returns null when writing the snip fails", async () => {
    const blocker = join(tmpdir(), `ht-paste-notdir-${Date.now()}`);
    cleanup.push(blocker);
    await writeFile(blocker, "not a directory");
    const service = new ClipboardPasteService({
      clipboard: fakeClipboard({
        availableFormats: () => ["image/png"],
        readImage: () => fakeImage(),
      }),
      pasteDirectory: join(blocker, "snip"),
    });

    expect(await service.readForTerminal()).toBeNull();
  });

  it("translates dropped Windows paths into quoted POSIX paths", async () => {
    const service = new ClipboardPasteService({
      clipboard: fakeClipboard(),
      toAgentPath: toPosixPath,
    });
    expect(await service.importPaths([
      String.raw`C:\Users\John Doe\a.png`,
      String.raw`C:\Users\John Doe\b.jpg`,
    ])).toBe(
      "'/mnt/c/Users/John Doe/a.png' '/mnt/c/Users/John Doe/b.jpg'",
    );
    expect(await service.importPaths(["", "\0evil", 4, null])).toBeNull();
  });

  it("sweeps paste files older than a day and keeps recent snips", async () => {
    const directory = join(tmpdir(), `ht-paste-${Date.now()}-sweep`);
    cleanup.push(directory);
    await mkdir(directory, { recursive: true });
    const stale = join(directory, "old.png");
    const fresh = join(directory, "new.png");
    await writeFile(stale, TINY_PNG);
    await writeFile(fresh, TINY_PNG);
    const now = Date.now();
    await utimes(stale, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));
    await utimes(fresh, new Date(now), new Date(now));

    await sweepPasteDirectory(directory, now);

    await expect(readFile(fresh)).resolves.toEqual(TINY_PNG);
    await expect(readFile(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sweeps oldest snips once the directory exceeds a byte budget", async () => {
    const directory = join(tmpdir(), `ht-paste-${Date.now()}-bytes`);
    cleanup.push(directory);
    await mkdir(directory, { recursive: true });
    const older = join(directory, "older.png");
    const newer = join(directory, "newer.png");
    await writeFile(older, TINY_PNG);
    await writeFile(newer, TINY_PNG);
    const now = Date.now();
    await utimes(older, new Date(now - 60_000), new Date(now - 60_000));
    await utimes(newer, new Date(now), new Date(now));

    await sweepPasteDirectory(directory, now, TINY_PNG.byteLength);

    await expect(readFile(newer)).resolves.toEqual(TINY_PNG);
    await expect(readFile(older)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
