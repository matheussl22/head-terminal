// In-page layer for the demo recording: a fake mouse cursor, captions, focus
// rings and the title card. Injected with Runtime.evaluate, so it is plain
// DOM + CSS and everything animates on the compositor the screencast reads.
export const OVERLAY_JS = String.raw`(() => {
  if (window.__demo) return true;
  // JS timers are not covered by the CDP animation playback rate.
  const slow = (ms) => ms * (window.__demoSlow || 1);
  const css = ${"`"}
    .agent-toolbar__title { font-size: 0 !important; }
    .agent-toolbar__title::before { content: "Head Terminal"; font-size: 13px; }
    /* Live CPU/memory/disk of the recording machine: not part of the story. */
    .resource-meter { visibility: hidden !important; }
    .app-shell { transform-origin: 0 0; transition: transform .7s cubic-bezier(.45,0,.2,1); will-change: transform; }
    #demo-root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483600;
      font-family: "Segoe UI Variable Display", "Segoe UI", Inter, sans-serif; }
    .demo-cursor { position: absolute; left: 0; top: 0; width: 28px; height: 28px; z-index: 5;
      transform: translate(1500px, 960px); transition-property: transform;
      transition-timing-function: cubic-bezier(.35,.75,.2,1); will-change: transform;
      filter: drop-shadow(0 3px 7px rgba(0,0,0,.6)); }
    .demo-cursor svg { display: block; transform-origin: 4px 3px; transition: transform .12s ease; }
    .demo-cursor.pressed svg { transform: scale(.84); }
    .demo-ripple { position: absolute; left: 0; top: 0; width: 14px; height: 14px; margin: -7px 0 0 -7px;
      border-radius: 50%; border: 2px solid rgba(240,168,50,.95); z-index: 4;
      animation: demo-ripple .55s cubic-bezier(.2,.8,.2,1) forwards; }
    @keyframes demo-ripple { from { transform: scale(.5); opacity: 1 } to { transform: scale(3.6); opacity: 0 } }
    .demo-caption { position: absolute; left: 50%; bottom: 64px; z-index: 3;
      transform: translate(-50%, 14px) scale(.98); opacity: 0;
      transition: opacity .28s ease, transform .4s cubic-bezier(.2,.8,.2,1);
      display: flex; align-items: center; gap: 16px; padding: 15px 26px 15px 20px;
      background: rgba(21,23,27,.94); border: 1px solid #3a3e46; border-radius: 14px;
      box-shadow: 0 22px 60px rgba(0,0,0,.6), 0 0 0 1px rgba(0,0,0,.35); white-space: nowrap; }
    .demo-caption.on { opacity: 1; transform: translate(-50%, 0) scale(1); }
    .demo-caption .sq { width: 14px; height: 14px; border-radius: 4px; background: #f0a832; flex: none;
      box-shadow: 0 0 14px rgba(240,168,50,.55); }
    .demo-caption .t { font-size: 26px; font-weight: 650; color: #eef0f3; letter-spacing: .003em; line-height: 1.2; }
    .demo-caption .s { font-size: 17px; font-weight: 450; color: #a9adb5; margin-top: 3px; }
    .demo-caption kbd { font: 600 15px "Cascadia Mono", Consolas, monospace; color: #e6e7ea; background: #1b1e23;
      border: 1px solid #3a3e46; border-bottom-width: 3px; border-radius: 6px; padding: 3px 8px; margin-left: 6px;
      vertical-align: 3px; }
    .demo-ring { position: absolute; border-radius: 9px; z-index: 2;
      box-shadow: 0 0 0 2px rgba(240,168,50,.95), 0 0 22px 4px rgba(240,168,50,.35);
      animation: demo-ring-in .35s cubic-bezier(.2,.8,.2,1) both, demo-ring-pulse 1.3s ease-in-out .35s infinite; }
    .demo-ring.out { animation: demo-ring-out .25s ease forwards; }
    @keyframes demo-ring-in { from { opacity: 0; transform: scale(1.25) } to { opacity: 1; transform: none } }
    @keyframes demo-ring-out { to { opacity: 0; transform: scale(1.08) } }
    @keyframes demo-ring-pulse { 50% { box-shadow: 0 0 0 2px rgba(240,168,50,.7), 0 0 30px 8px rgba(240,168,50,.18) } }
    .demo-card { position: absolute; inset: 0; z-index: 6; display: grid; place-items: center; opacity: 0;
      background: radial-gradient(ellipse 58% 48% at 50% 46%, rgba(240,168,50,.11), transparent 72%), rgba(8,9,11,.82);
      backdrop-filter: blur(16px) saturate(115%); transition: opacity .55s ease; }
    .demo-card.on { opacity: 1; }
    .demo-card.instant { transition: none; }
    .demo-card .inner { text-align: center; transform: translateY(8px) scale(.985);
      transition: transform .7s cubic-bezier(.2,.8,.2,1); }
    .demo-card.on .inner { transform: none; }
    .demo-card .wordmark { display: flex; align-items: center; justify-content: center; gap: 24px; }
    .demo-card .wordmark .sq { width: 50px; height: 50px; border-radius: 13px; background: #f0a832;
      box-shadow: 0 0 50px rgba(240,168,50,.38), inset 0 -3px 0 rgba(0,0,0,.12); }
    .demo-card .wordmark .name { font-size: 80px; font-weight: 700; color: #f4f5f7; letter-spacing: -.025em; line-height: 1; }
    .demo-card .tagline { margin-top: 22px; font-size: 29px; font-weight: 450; color: #b4b8bf; }
    .demo-card .pills { margin-top: 36px; display: flex; gap: 12px; justify-content: center; }
    .demo-card .pill { display: flex; align-items: center; gap: 10px; padding: 10px 18px; border-radius: 999px;
      background: rgba(21,23,27,.9); border: 1px solid #2f3339; font-size: 19px; font-weight: 600; color: #e6e7ea; }
    .demo-card .pill i { width: 9px; height: 9px; border-radius: 50%; }
    .demo-card .meta { margin-top: 40px; font: 500 19px "Cascadia Mono", Consolas, monospace; color: #80858e; }
    .demo-card .meta b { color: #c9ccd2; font-weight: 600; }
  ${"`"};
  const style = document.createElement("style");
  style.id = "demo-style";
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "demo-root";
  document.body.appendChild(root);

  const cursor = document.createElement("div");
  cursor.className = "demo-cursor";
  cursor.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M4.5 3.2 L4.5 22.6 L9.6 17.9 L13.1 25.4 L16.6 23.8 L13.2 16.5 L20.2 16.5 Z" fill="#f4f5f7" stroke="#0b0c0e" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  root.appendChild(cursor);
  let cx = 1500;
  let cy = 960;

  const caption = document.createElement("div");
  caption.className = "demo-caption";
  root.appendChild(caption);

  const card = document.createElement("div");
  card.className = "demo-card";
  const pill = (color, label) => '<span class="pill"><i style="background:' + color + ';box-shadow:0 0 10px ' + color + '"></i>' + label + "</span>";
  card.innerHTML =
    '<div class="inner">' +
      '<div class="wordmark"><span class="sq"></span><span class="name">Head Terminal</span></div>' +
      '<div class="tagline">AI coding agents side by side, in one window.</div>' +
      '<div class="pills">' +
        pill("#e8a27a", "Claude Code") + pill("#5fd1b3", "Codex") + pill("#c9ccd2", "Cursor Agent") +
        pill("#f0c85a", "Antigravity") + pill("#8b9099", "Shell") +
      "</div>" +
      '<div class="meta"><b>github.com/matheussl22/head-terminal</b> · Windows · macOS · Linux</div>' +
    "</div>";
  root.appendChild(card);

  let captionTimer = null;
  const rings = new Map();
  let ringSeq = 0;

  window.__demo = {
    move(x, y, ms) {
      cursor.style.transitionDuration = ms + "ms";
      cursor.style.transform = "translate(" + (x - 4) + "px," + (y - 3) + "px)";
      cx = x;
      cy = y;
      return true;
    },
    press() {
      cursor.classList.add("pressed");
      setTimeout(() => cursor.classList.remove("pressed"), slow(140));
      const ripple = document.createElement("div");
      ripple.className = "demo-ripple";
      ripple.style.transform = "none";
      ripple.style.left = cx + "px";
      ripple.style.top = cy + "px";
      root.appendChild(ripple);
      setTimeout(() => ripple.remove(), slow(700));
      return true;
    },
    caption(title, sub, kbd) {
      clearTimeout(captionTimer);
      const show = () => {
        caption.innerHTML = '<span class="sq"></span><div><div class="t">' + title +
          (kbd ? " <kbd>" + kbd + "</kbd>" : "") + "</div>" + (sub ? '<div class="s">' + sub + "</div>" : "") + "</div>";
        caption.classList.add("on");
      };
      if (!title) {
        caption.classList.remove("on");
        return true;
      }
      if (caption.classList.contains("on")) {
        caption.classList.remove("on");
        captionTimer = setTimeout(show, slow(280));
      } else {
        show();
      }
      return true;
    },
    // Camera move: scales the whole app around a point, overlay untouched.
    zoom(scale, ox = 0, oy = 0, ms = 700) {
      const shell = document.querySelector(".app-shell");
      if (!shell) return false;
      shell.style.transitionDuration = ms + "ms";
      if (scale === 1) {
        shell.style.transform = "none";
      } else {
        // Keep (ox, oy) fixed on screen: translate so the point maps to itself.
        const tx = ox - ox * scale;
        const ty = oy - oy * scale;
        shell.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
      }
      return true;
    },
    ring(selector, pad = 5, radius = 9) {
      const el = typeof selector === "string" ? document.querySelector(selector) : selector;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const ring = document.createElement("div");
      ring.className = "demo-ring";
      ring.style.left = r.left - pad + "px";
      ring.style.top = r.top - pad + "px";
      ring.style.width = r.width + pad * 2 + "px";
      ring.style.height = r.height + pad * 2 + "px";
      ring.style.borderRadius = radius + "px";
      root.appendChild(ring);
      const id = ++ringSeq;
      rings.set(id, ring);
      return id;
    },
    unring(id) {
      const ids = id == null ? [...rings.keys()] : [id];
      for (const key of ids) {
        const ring = rings.get(key);
        if (!ring) continue;
        rings.delete(key);
        ring.classList.add("out");
        setTimeout(() => ring.remove(), slow(300));
      }
      return true;
    },
    card(on, instant = false) {
      card.classList.toggle("instant", instant);
      card.classList.toggle("on", on);
      if (instant) void card.offsetWidth;
      card.classList.remove("instant");
      return true;
    },
  };
  return true;
})()`;
