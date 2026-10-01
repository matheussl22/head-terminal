#!/usr/bin/env node
// Windows CDP e2e: session hibernation and the phone remote, end to end,
// against `npm run dev` (smoke shell panes). The "phone" is this script,
// talking HTTPS to the remote server bound to loopback.
import { execFile } from "node:child_process";
import { request } from "node:https";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  clickByText,
  connectRenderer,
  dumpFailure,
  evaluate,
  fail,
  poll,
  spawnDev,
  stopApp,
  waitForPtySpawn,
  withWorkDir,
} from "./e2e-win-harness.mjs";

process.env.HEAD_TERMINAL_REMOTE_BIND = "127.0.0.1";
// Real hibernation waits minutes; the phone's "hibernate now" drives it here.
// HEAD_TERMINAL_E2E_KEEP=1 keeps the work dir and its screenshots.

function https(port, method, path, { body, cookie, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : raw ?? Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        rejectUnauthorized: false,
        headers: {
          "X-HT-Remote": "1",
          ...(payload ? { "Content-Type": raw ? "audio/webm" : "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // Not JSON (HTML, empty).
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** An SSE stream: keeps the last `state` and the last `screen`. */
function events(port, cookie, paneId) {
  const latest = { state: null, screen: null, bye: false };
  const req = request({
    host: "127.0.0.1",
    port,
    method: "GET",
    path: `/api/events${paneId ? `?pane=${encodeURIComponent(paneId)}` : ""}`,
    rejectUnauthorized: false,
    headers: { Cookie: cookie, Accept: "text/event-stream" },
  });
  req.on("response", (res) => {
    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length === 0) continue;
        if (event === "bye") latest.bye = true;
        try {
          latest[event] = JSON.parse(data.join("\n"));
        } catch {
          // Keepalives and the like.
        }
      }
    });
  });
  req.on("error", () => undefined);
  req.end();
  return { latest, close: () => req.destroy() };
}

function processAlive(pid) {
  return new Promise((resolve) => {
    execFile("tasklist.exe", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { windowsHide: true }, (error, stdout) =>
      resolve(!error && stdout.includes(`"${pid}"`)),
    );
  });
}

function screenText(screen) {
  return (screen?.lines ?? []).map((runs) => runs.map(([text]) => text).join("")).join("\n");
}

async function until(read, predicate, what, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await delay(200);
  }
  fail(`timed out waiting for ${what}; last=${JSON.stringify(last)?.slice(0, 600)}`);
}

async function command(port, cookie, body) {
  const response = await https(port, "POST", "/api/command", { body, cookie });
  return response.json ?? { ok: false, error: `HTTP ${response.status} ${response.text}` };
}

async function screenshot(cdp, path) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(path, Buffer.from(data, "base64"));
}

async function main() {
  await withWorkDir(async ({ workDir, userData, debug, debugPath }) => {
    const logPath = join(workDir, "dev.log");
    const { child, state } = spawnDev({ userData, logPath });
    let cdp;
    const streams = [];
    try {
      cdp = await connectRenderer({ child, state, debug });
      await waitForPtySpawn(cdp);

      // ── The remote comes up and pairs ─────────────────────────────────
      const status = await evaluate(cdp, "window.headTerminal.remote.setEnabled(true)", true);
      debug(`remote status ${JSON.stringify(status)}`);
      const running = await poll(
        cdp,
        "window.headTerminal.remote.getStatus()",
        { awaitPromise: true, predicate: (value) => value?.running && value.pin, timeout: 20_000 },
      );
      const port = running.port;
      const page = await https(port, "GET", "/");
      if (page.status !== 200 || !page.text.includes("<html")) fail(`GET / → ${page.status}`);
      if ((await https(port, "GET", "/api/me")).status !== 401) fail("/api/me answered without a cookie");
      if ((await https(port, "POST", "/api/pair", { body: { pin: "000000", name: "x" } })).status === 200
        && running.pin !== "000000") {
        fail("a wrong PIN paired");
      }
      const paired = await https(port, "POST", "/api/pair", { body: { pin: running.pin, name: "e2e phone" } });
      if (paired.status !== 200) fail(`pairing failed ${paired.status} ${paired.text}`);
      const cookie = String(paired.headers["set-cookie"]?.[0] ?? "").split(";")[0];
      if (!cookie.startsWith("ht_remote=")) fail(`no cookie: ${paired.headers["set-cookie"]}`);
      debug("paired");

      const all = events(port, cookie);
      streams.push(all);
      const first = await until(
        () => all.latest.state,
        (value) => value?.sessions?.length === 1 && value.sessions[0].state === "live",
        "the first snapshot",
      );
      const sessionA = first.sessions[0];
      const paneA = sessionA.panes[0].paneId;
      debug(`session A ${sessionA.sessionId} pane ${paneA}`);

      // ── Typing from the phone, reading the screen back ────────────────
      const watchA = events(port, cookie, paneA);
      streams.push(watchA);
      await until(() => watchA.latest.screen, (screen) => screen?.paneId === paneA, "pane A's screen");
      const sent = await command(port, cookie, {
        type: "send-text",
        paneId: paneA,
        text: "echo ('hello' + '-from-phone')",
        submit: true,
      });
      if (!sent.ok) fail(`send-text: ${sent.error}`);
      await until(
        () => screenText(watchA.latest.screen),
        (text) => text.includes("hello-from-phone"),
        "the command's output on the phone",
      );
      debug("phone typed and read the screen");
      await command(port, cookie, { type: "send-text", paneId: paneA, text: "echo \"SHELLPID=$PID\"", submit: true });
      const pidText = await until(
        () => screenText(watchA.latest.screen),
        (text) => /SHELLPID=\d+/u.test(text),
        "the shell's pid",
      );
      const shellPid = Number(/SHELLPID=(\d+)/u.exec(pidText)[1]);
      if (!(await processAlive(shellPid))) fail(`shell ${shellPid} not running`);
      debug(`pane A shell pid ${shellPid}`);

      // A phone looking at a pane keeps it awake.
      const watched = await command(port, cookie, { type: "hibernate-session", sessionId: sessionA.sessionId });
      if (watched.ok) fail("hibernated a session a phone was watching");
      debug(`refused while watched: ${watched.error}`);
      watchA.close();
      await delay(500);

      // ── A second session takes the screen; A goes to the background ───
      await evaluate(cdp, `document.querySelector(".session-sidebar__new").click()`);
      await poll(cdp, `Boolean(document.querySelector(".create-session-dialog"))`);
      await poll(
        cdp,
        `![...document.querySelectorAll(".create-session-dialog__agent small")].some((el) => (el.textContent || "").includes("Instalando"))`,
        { timeout: 60_000 },
      );
      await clickByText(cdp, ".create-session-dialog__agent", "Shell");
      await delay(200);
      await evaluate(cdp, `document.querySelector(".create-session-dialog__create").click()`);
      await until(() => all.latest.state, (value) => value?.sessions?.length === 2, "the second session");

      // A job keeps the shell busy: hibernating would kill it.
      const job = await command(port, cookie, {
        type: "send-text",
        paneId: paneA,
        text: "$job = Start-Job { Start-Sleep 600 }",
        submit: true,
      });
      if (!job.ok) fail(`start job: ${job.error}`);
      await delay(4_000);
      const busy = await command(port, cookie, { type: "hibernate-session", sessionId: sessionA.sessionId });
      if (busy.ok) fail("hibernated a shell with a background job");
      debug(`refused with a job running: ${busy.error}`);
      await command(port, cookie, { type: "send-text", paneId: paneA, text: "Stop-Job $job; Remove-Job $job", submit: true });
      await delay(3_000);

      // ── Hibernate A ────────────────────────────────────────────────────
      if (!(await processAlive(shellPid))) fail("pane A's shell died before hibernating");
      const slept = await command(port, cookie, { type: "hibernate-session", sessionId: sessionA.sessionId });
      if (!slept.ok) fail(`hibernate: ${slept.error}`);
      await until(
        () => all.latest.state,
        (value) => value?.sessions?.find((item) => item.sessionId === sessionA.sessionId)?.state === "hibernated",
        "A hibernated in the snapshot",
      );
      await until(() => processAlive(shellPid), (alive) => !alive, "pane A's shell to be gone");
      debug(`shell ${shellPid} is gone`);
      debug(`sidebar A ${await evaluate(cdp, `JSON.stringify([...document.querySelectorAll('[data-session-id=${JSON.stringify(sessionA.sessionId)}] [title]')].map((el) => el.getAttribute("title")))`)}`);
      await poll(
        cdp,
        `[...document.querySelectorAll('[data-session-id=${JSON.stringify(sessionA.sessionId)}] *')]
          .some((el) => /hibernada|hibernated/iu.test((el.getAttribute("title") || "") + (el.children.length ? "" : el.textContent || "")))`,
      );
      await screenshot(cdp, join(workDir, "hibernated.png"));
      const refused = await command(port, cookie, { type: "send-key", paneId: paneA, key: "enter" });
      if (refused.ok) fail("typed into a hibernated pane");

      // ── Wake A from the phone: same scrollback, a fresh shell ─────────
      const woke = await command(port, cookie, { type: "wake-session", sessionId: sessionA.sessionId });
      if (!woke.ok) fail(`wake: ${woke.error}`);
      const rewatch = events(port, cookie, paneA);
      streams.push(rewatch);
      const restored = await until(
        () => screenText(rewatch.latest.screen),
        (text) => text.includes("hello-from-phone") && /retomado após hibernar|resumed after hibernating/u.test(text),
        "A's scrollback after waking",
        30_000,
      );
      debug(`restored screen tail: ${JSON.stringify(restored.slice(-300))}`);
      const again = await command(port, cookie, {
        type: "send-text",
        paneId: paneA,
        text: "echo ('awake' + '-again')",
        submit: true,
      });
      if (!again.ok) fail(`send-text after wake: ${again.error}`);
      await until(() => screenText(rewatch.latest.screen), (text) => text.includes("awake-again"), "a live shell after waking");

      // ── Settings › Celular shows the pairing QR ───────────────────────
      await evaluate(cdp, `[...document.querySelectorAll(".agent-toolbar button")].find((el) => /Configura|Settings/u.test(el.textContent || ""))?.click()`);
      await delay(500);
      await evaluate(cdp, `[...document.querySelectorAll(".settings-nav__item")].find((el) => /Celular|Phone/u.test(el.textContent || ""))?.click()`);
      await delay(500);
      const qr = await evaluate(cdp, `Boolean(document.querySelector(".remote-settings__qr path"))`);
      await screenshot(cdp, join(workDir, "settings-phone.png"));
      debug(`settings QR rendered=${qr}`);

      if (process.env.HEAD_TERMINAL_E2E_KEEP === "1") {
        console.log(`OK — screenshots in ${workDir}`);
        // Kept for a look: the work dir only survives a failure otherwise.
        throw Object.assign(new Error("keep"), { keep: true });
      }
      console.log("OK");
    } catch (error) {
      if (!error?.keep) {
        await dumpFailure({ debug, logPath, cdp });
      }
      throw error;
    } finally {
      for (const stream of streams) stream.close();
      await stopApp({ cdp, child, state });
      debug(`debug log ${debugPath}`);
    }
  }).catch((error) => {
    if (error?.keep) return;
    console.error(error);
    process.exitCode = 1;
  });
}

void main();
