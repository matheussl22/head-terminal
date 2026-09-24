#!/usr/bin/env node
// Turns the frames saved by record-demo-win.mjs into the README media.
//
//   node scripts/demo/encode.mjs [framesDir] [outDir]
//
// The screencast only emits a frame when something changed, stamped with its
// capture time, so frames are placed on a constant-rate timeline here. Spans
// the recorder marked "ff-start"/"ff-end" (the app spawning a terminal) play
// faster. Needs ffmpeg on PATH.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FRAMES = resolve(process.argv[2] ?? join(tmpdir(), "head-terminal-demo", "frames"));
const OUT = resolve(process.argv[3] ?? join(tmpdir(), "head-terminal-demo", "out"));
const NAME = process.env.HT_DEMO_NAME ?? "head-terminal-demo";
const MP4_FPS = 30;
const GIF_FPS = Number(process.env.HT_DEMO_GIF_FPS ?? 15);
const GIF_WIDTH = Number(process.env.HT_DEMO_GIF_WIDTH ?? 960);
const MP4_WIDTH = Number(process.env.HT_DEMO_MP4_WIDTH ?? 1440);
const FF_SPEED = Number(process.env.HT_DEMO_FF_SPEED ?? 6);
// A hairline frame keeps the dark UI from melting into GitHub's dark theme.
const BORDER = "drawbox=x=0:y=0:w=iw:h=ih:color=0x30363d:t=1";

mkdirSync(OUT, { recursive: true });
const index = JSON.parse(readFileSync(join(FRAMES, "index.json"), "utf8"));
// Leave a sliver of each fast-forward at normal speed so the click lands.
const FF_LEAD = 0.25 * Number(index.slowmo ?? 1);
const t0 = index.frames[0].t;
const times = index.frames.map((f) => f.t - t0);
const beats = index.beats;
// Recorded in slow motion: play everything back that much faster.
// HT_DEMO_SPEED trims the whole thing a little on top, for a snappier loop.
const BASE = Number(index.slowmo ?? 1) * Number(process.env.HT_DEMO_SPEED ?? 1.2);
const end = beats.find((b) => b.name === "end")?.at ?? times.at(-1);

// Source-time segments with their playback speed.
const segments = [];
let cursor = 0;
let open = null;
for (const b of beats) {
  if (b.name === "ff-start") open = b.at + FF_LEAD;
  if (b.name === "ff-end" && open != null && b.at > open) {
    segments.push({ from: cursor, to: open, speed: BASE });
    segments.push({ from: open, to: b.at, speed: BASE * FF_SPEED });
    cursor = b.at;
    open = null;
  }
}
segments.push({ from: cursor, to: end, speed: BASE });
const outDuration = segments.reduce((sum, s) => sum + (s.to - s.from) / s.speed, 0);

function sourceAt(outTime) {
  let acc = 0;
  for (const s of segments) {
    const len = (s.to - s.from) / s.speed;
    if (outTime <= acc + len) return s.from + (outTime - acc) * s.speed;
    acc += len;
  }
  return end;
}

function frameAt(src) {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= src) lo = mid;
    else hi = mid - 1;
  }
  return index.frames[lo].file;
}

function concatList(fps, name) {
  const count = Math.round(outDuration * fps);
  const picks = [];
  for (let k = 0; k < count; k += 1) picks.push(frameAt(sourceAt(k / fps)));
  let text = "ffconcat version 1.0\n";
  let i = 0;
  while (i < picks.length) {
    let j = i;
    while (j + 1 < picks.length && picks[j + 1] === picks[i]) j += 1;
    text += `file '${join(FRAMES, picks[i]).replaceAll("\\", "/")}'\nduration ${((j - i + 1) / fps).toFixed(6)}\n`;
    i = j + 1;
  }
  text += `file '${join(FRAMES, picks.at(-1)).replaceAll("\\", "/")}'\n`;
  const path = join(OUT, name);
  writeFileSync(path, text);
  return path;
}

const ffmpeg = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
const size = (path) => `${(statSync(path).size / 1024 / 1024).toFixed(2)} MB`;

console.log(`source ${end.toFixed(2)}s → output ${outDuration.toFixed(2)}s, ${segments.filter((s) => s.speed > BASE).length} fast-forwards`, `(base speed ${BASE}×)`);

const mp4 = join(OUT, `${NAME}.mp4`);
ffmpeg([
  "-f", "concat", "-safe", "0", "-i", concatList(MP4_FPS, "mp4.ffconcat"),
  "-vf", `fps=${MP4_FPS},scale=${MP4_WIDTH}:-2:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
  "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-tune", "animation", "-profile:v", "high", "-level:v", "4.1",
  "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
  "-movflags", "+faststart", mp4,
]);
console.log(`${mp4} ${size(mp4)}`);

const gif = join(OUT, `${NAME}.gif`);
ffmpeg([
  "-f", "concat", "-safe", "0", "-i", concatList(GIF_FPS, "gif.ffconcat"),
  "-vf",
  `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,${BORDER},split[a][b];` +
    `[a]palettegen=max_colors=${process.env.HT_DEMO_GIF_COLORS ?? 128}:stats_mode=${process.env.HT_DEMO_GIF_STATS ?? "full"}:reserve_transparent=0[p];` +
    `[b][p]paletteuse=dither=${process.env.HT_DEMO_GIF_DITHER ?? "none"}:diff_mode=rectangle`,
  "-loop", "0", gif,
]);
console.log(`${gif} ${size(gif)}`);

// Animated WebP: same loop, a fraction of the GIF's size, for pages that take it.
const webp = join(OUT, `${NAME}.webp`);
ffmpeg([
  "-f", "concat", "-safe", "0", "-i", concatList(GIF_FPS, "webp.ffconcat"),
  "-vf", `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,${BORDER}`,
  "-c:v", "libwebp_anim", "-q:v", "72", "-compression_level", "6", "-loop", "0", webp,
]);
console.log(`${webp} ${size(webp)}`);
