/* Head Terminal — phone remote.
 *
 * Vanilla ES2020, no build step, no libraries. Served under a CSP that
 * allows no inline script or style: every dynamic visual goes through
 * classes, CSS custom properties (CSSOM) or a constructed stylesheet.
 *
 * State arrives over one EventSource (/api/events): `state` carries the
 * whole session list, `screen` the terminal the user has open. Everything
 * the phone does is a POST to /api/command (or /api/transcribe for audio).
 */
(function () {
  "use strict";

  // ------------------------------------------------------------------ i18n

  const LANG = String(navigator.language || "").toLowerCase().startsWith("pt") ? "pt" : "en";

  const STRINGS = {
    pt: {
      connecting: "Conectando…",
      cantConnect: "Não foi possível falar com o Head Terminal.",
      retry: "Tentar de novo",
      pairTitle: "Conectar este celular",
      pairSubtitle: "Digite o PIN para controlar suas sessões daqui.",
      pinLabel: "PIN",
      nameLabel: "Nome deste aparelho",
      pairButton: "Parear",
      pairing: "Pareando…",
      pairHint: "O PIN aparece no Head Terminal em Configurações › Celular.",
      pinIncomplete: "O PIN tem 6 dígitos.",
      pinWrong: "PIN incorreto. Confira no PC e tente de novo.",
      pinLocked: (minutes) => `Muitas tentativas erradas. Tente de novo em ${minutes} min.`,
      pairFailed: "Não foi possível parear este aparelho.",
      paired: "Celular conectado.",
      network: "Sem conexão com o Head Terminal.",
      revoked: "Este aparelho foi desconectado no PC.",
      thisDevice: "Celular",
      sessions: "Sessões",
      online: "Conectado",
      offline: "Reconectando…",
      offlineBanner: "Sem conexão — reconectando…",
      loadingSessions: "Carregando sessões…",
      noSessions: "Nenhuma sessão aberta",
      noSessionsHint: "Crie uma sessão no Head Terminal do PC e ela aparece aqui.",
      onPc: "No PC",
      wake: "Acordar",
      waking: "Acordando…",
      starting: "Iniciando",
      idle: "Pronto",
      working: "Executando",
      waiting: "Aguardando",
      done: "Concluído",
      error: "Erro",
      fallback: "Shell",
      exited: "Encerrado",
      hibernated: "Hibernada",
      notStarted: "Não iniciada",
      hibernatedShort: "hibernada",
      notStartedShort: "não iniciada",
      blocked_approval: "Aprovação",
      blocked_question: "Pergunta",
      blocked_dialog: "Confirmação",
      agoNow: "agora",
      agoMin: (n) => `há ${n} min`,
      agoHour: (n) => `há ${n} h`,
      agoDay: (n) => `há ${n} d`,
      context: (n) => `contexto ${n}%`,
      terminalN: (n) => `Terminal ${n}`,
      sleepingFoot: "Os processos estão parados.",
      notStartedFoot: "Ainda não foi aberta no PC.",
      back: "Voltar",
      more: "Mais opções",
      showOnPc: "Mostrar no PC",
      shownOnPc: "Aberto no PC.",
      hibernate: "Hibernar sessão",
      hibernateConfirm: "Hibernar esta sessão? Os processos dela param e a conversa é retomada quando ela acordar.",
      hibernating: "Hibernando a sessão…",
      wrap: "Quebra de linha",
      fontSize: "Tamanho da fonte",
      smaller: "Diminuir fonte",
      bigger: "Aumentar fonte",
      live: "ao vivo",
      placeholder: "Mensagem para o terminal",
      placeholderNoMic: "Digite ou use o ditado do teclado",
      send: "Enviar",
      mic: "Gravar áudio",
      micStop: "Parar gravação",
      recording: (time) => `Gravando ${time} — toque no microfone para parar`,
      transcribing: "Transcrevendo…",
      transcribeFailed: (message) => `Não deu para transcrever: ${message}`,
      transcribeEmpty: "Não entendi nada no áudio.",
      reviewHint: "Revise o texto e toque em enviar.",
      micDenied: "Sem acesso ao microfone. Libere nas permissões do navegador.",
      micUnavailable: "Gravação indisponível aqui — use o ditado do teclado.",
      enterOnSend: "Enter ao enviar",
      enterOn: "Enter ao enviar: ligado",
      enterOff: "Enter ao enviar: desligado — o texto é só colado",
      textTooLong: "Texto longo demais (máximo de 8000 caracteres).",
      paneGone: "Este terminal foi fechado",
      paneGoneHint: "Ele não existe mais no Head Terminal.",
      backToSessions: "Voltar às sessões",
      hibernatedTitle: "Sessão hibernada",
      notStartedTitle: "Sessão não iniciada",
      sleepingHint: "Acorde a sessão para ver o terminal e continuar a conversa.",
      loadingScreen: "Carregando a tela…",
      waitingToast: (session, index) => `${session} · terminal ${index} está aguardando você`,
      open: "Abrir",
      pairedAs: (name) => `Pareado como ${name}`,
      logout: "Desconectar este aparelho",
      logoutConfirm: "Desconectar este aparelho do Head Terminal? Vai ser preciso um PIN novo para voltar.",
      commandFailed: (message) => `Não deu certo: ${message}`,
      invalidCommand: "O Head Terminal recusou o comando.",
      keyEsc: "Esc",
      keyEnter: "Enter",
      keyTab: "Tab",
      keyShiftTab: "⇧Tab",
      keyCtrlC: "Ctrl+C",
    },
    en: {
      connecting: "Connecting…",
      cantConnect: "Could not reach Head Terminal.",
      retry: "Try again",
      pairTitle: "Connect this phone",
      pairSubtitle: "Type the PIN to control your sessions from here.",
      pinLabel: "PIN",
      nameLabel: "Name of this device",
      pairButton: "Pair",
      pairing: "Pairing…",
      pairHint: "The PIN is in Head Terminal under Settings › Phone.",
      pinIncomplete: "The PIN has 6 digits.",
      pinWrong: "Wrong PIN. Check it on the computer and try again.",
      pinLocked: (minutes) => `Too many wrong attempts. Try again in ${minutes} min.`,
      pairFailed: "Could not pair this device.",
      paired: "Phone connected.",
      network: "No connection to Head Terminal.",
      revoked: "This device was disconnected on the computer.",
      thisDevice: "Phone",
      sessions: "Sessions",
      online: "Connected",
      offline: "Reconnecting…",
      offlineBanner: "Offline — reconnecting…",
      loadingSessions: "Loading sessions…",
      noSessions: "No open sessions",
      noSessionsHint: "Create a session in Head Terminal on your computer and it shows up here.",
      onPc: "On PC",
      wake: "Wake",
      waking: "Waking…",
      starting: "Starting",
      idle: "Ready",
      working: "Running",
      waiting: "Waiting",
      done: "Done",
      error: "Error",
      fallback: "Shell",
      exited: "Exited",
      hibernated: "Hibernated",
      notStarted: "Not started",
      hibernatedShort: "hibernated",
      notStartedShort: "not started",
      blocked_approval: "Approval",
      blocked_question: "Question",
      blocked_dialog: "Confirmation",
      agoNow: "now",
      agoMin: (n) => `${n} min ago`,
      agoHour: (n) => `${n} h ago`,
      agoDay: (n) => `${n} d ago`,
      context: (n) => `context ${n}%`,
      terminalN: (n) => `Terminal ${n}`,
      sleepingFoot: "Its processes are stopped.",
      notStartedFoot: "Not opened on the computer yet.",
      back: "Back",
      more: "More options",
      showOnPc: "Show on computer",
      shownOnPc: "Opened on the computer.",
      hibernate: "Hibernate session",
      hibernateConfirm: "Hibernate this session? Its processes stop and the conversation resumes when it wakes up.",
      hibernating: "Hibernating the session…",
      wrap: "Wrap lines",
      fontSize: "Font size",
      smaller: "Smaller font",
      bigger: "Bigger font",
      live: "live",
      placeholder: "Message to the terminal",
      placeholderNoMic: "Type or use keyboard dictation",
      send: "Send",
      mic: "Record audio",
      micStop: "Stop recording",
      recording: (time) => `Recording ${time} — tap the mic to stop`,
      transcribing: "Transcribing…",
      transcribeFailed: (message) => `Could not transcribe: ${message}`,
      transcribeEmpty: "Heard nothing in the audio.",
      reviewHint: "Review the text and tap send.",
      micDenied: "No microphone access. Allow it in the browser's permissions.",
      micUnavailable: "Recording is not available here — use keyboard dictation.",
      enterOnSend: "Enter on send",
      enterOn: "Enter on send: on",
      enterOff: "Enter on send: off — the text is only pasted",
      textTooLong: "Text too long (8000 characters at most).",
      paneGone: "This terminal was closed",
      paneGoneHint: "It no longer exists in Head Terminal.",
      backToSessions: "Back to sessions",
      hibernatedTitle: "Session hibernated",
      notStartedTitle: "Session not started",
      sleepingHint: "Wake the session to see the terminal and continue the conversation.",
      loadingScreen: "Loading the screen…",
      waitingToast: (session, index) => `${session} · terminal ${index} is waiting for you`,
      open: "Open",
      pairedAs: (name) => `Paired as ${name}`,
      logout: "Disconnect this device",
      logoutConfirm: "Disconnect this device from Head Terminal? A new PIN will be needed to come back.",
      commandFailed: (message) => `That did not work: ${message}`,
      invalidCommand: "Head Terminal refused the command.",
      keyEsc: "Esc",
      keyEnter: "Enter",
      keyTab: "Tab",
      keyShiftTab: "⇧Tab",
      keyCtrlC: "Ctrl+C",
    },
  };

  function t(key, ...args) {
    const value = key in STRINGS[LANG] ? STRINGS[LANG][key] : STRINGS.pt[key];
    if (typeof value === "function") return value(...args);
    return value === undefined ? key : value;
  }

  // ------------------------------------------------------------------ dom helpers

  const $ = (id) => document.getElementById(id);

  /** Builds an element. Never sets a `style` attribute: the CSP forbids it. */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === "class") el.className = value;
        else if (key === "text") el.textContent = value;
        else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
        else el.setAttribute(key, value === true ? "" : String(value));
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const cx = (...names) => names.filter(Boolean).join(" ");

  const ICON_PATHS = {
    back: '<path d="m15 18-6-6 6-6"/>',
    more: '<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    send: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><path d="M12 18v4"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    enter: '<path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
    wrap: '<path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/>',
    text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    gone: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m9.5 9.5 5 5M14.5 9.5l-5 5"/>',
  };

  function icon(name) {
    const tpl = document.createElement("template");
    // Static markup from the table above, never data.
    tpl.innerHTML = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
    return tpl.content.firstChild;
  }

  function setIcon(el, name) {
    el.replaceChildren(icon(name));
  }

  // ------------------------------------------------------------------ prefs

  const storage = {
    get(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (error) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        // Private mode: preferences last as long as the page.
      }
    },
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const FONT_MIN = 9;
  const FONT_MAX = 22;

  const prefs = {
    wrap: storage.get("ht.remote.wrap", true) !== false,
    fontSize: clamp(Number(storage.get("ht.remote.fontSize", 12)) || 12, FONT_MIN, FONT_MAX),
    submit: storage.get("ht.remote.submit", true) !== false,
  };

  // ------------------------------------------------------------------ state

  const state = {
    view: "boot",
    paneId: null,
    device: null,
    snapshot: null,
    screen: null,
    conn: "connecting",
    /** paneId → was waiting in the last snapshot. */
    waiting: new Map(),
    /** Panes that just started waiting: highlighted on the next render. */
    attention: new Set(),
    /** sessionId → when to give up showing "waking". */
    waking: new Map(),
    drafts: new Map(),
    follow: true,
    /** PC clock minus phone clock, from the Date header. */
    skew: 0,
    defaultName: "",
    /** Pane + wait the answer keys were last scrolled into view for. */
    hotKey: null,
  };

  const pcNow = () => Date.now() - state.skew;

  // ------------------------------------------------------------------ api

  async function api(path, options = {}) {
    const method = options.method || "GET";
    const init = { method, credentials: "same-origin", cache: "no-store", headers: {} };
    if (method === "POST") {
      init.headers["X-HT-Remote"] = "1";
      if (options.blob) {
        init.headers["Content-Type"] = options.contentType;
        init.body = options.blob;
      } else {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body === undefined ? {} : options.body);
      }
    }
    let response;
    try {
      response = await fetch(path, init);
    } catch (error) {
      return { ok: false, status: 0, data: null };
    }
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    if (response.status === 401 && !options.allow401) {
      toPair(state.device ? t("revoked") : null);
    }
    return { ok: response.ok, status: response.status, data, response };
  }

  async function command(payload) {
    const result = await api("/api/command", { method: "POST", body: payload });
    if (result.ok) return true;
    if (result.status === 401) return false;
    toast(commandError(result), { kind: "error" });
    return false;
  }

  function commandError(result) {
    if (result.status === 0) return t("network");
    const error = result.data && result.data.error;
    if (result.status === 400) return t("invalidCommand");
    return t("commandFailed", error || `HTTP ${result.status}`);
  }

  // ------------------------------------------------------------------ status model

  const TONE_RANK = { waiting: 7, error: 6, fallback: 5, working: 4, starting: 3, done: 2.5, idle: 2, exited: 1 };

  function paneStatus(session, pane) {
    if (session.state !== "live") {
      const short = session.state === "hibernated" ? t("hibernatedShort") : t("notStartedShort");
      if (pane.done) return { tone: "done", glyph: "done", label: `${t("done")} · ${short}` };
      return {
        tone: "dormant",
        glyph: "dormant",
        label: session.state === "hibernated" ? t("hibernated") : t("notStarted"),
      };
    }
    switch (pane.activity) {
      case "waiting_input": {
        const reason = pane.blockedReason ? t(`blocked_${pane.blockedReason}`) : t("waiting");
        const detail = typeof pane.blockedDetail === "string" ? pane.blockedDetail.trim() : "";
        return { tone: "waiting", glyph: "waiting", label: detail ? `${reason} · ${detail}` : reason };
      }
      case "error":
        return { tone: "error", glyph: "error", label: t("error") };
      case "agent_fallback":
        return { tone: "fallback", glyph: "fallback", label: t("fallback") };
      case "working":
        return { tone: "working", glyph: "working", label: t("working") };
      case "starting":
        return { tone: "starting", glyph: "starting", label: t("starting") };
      case "exited":
        return { tone: "exited", glyph: "exited", label: t("exited") };
      default:
        return pane.done
          ? { tone: "done", glyph: "done", label: t("done") }
          : { tone: "idle", glyph: "idle", label: t("idle") };
    }
  }

  /** What the card says: the pane that needs the user most speaks for all. */
  function sessionStatus(session) {
    if (session.state !== "live") {
      const sleeping = session.state === "hibernated" ? t("hibernated") : t("notStarted");
      const short = session.state === "hibernated" ? t("hibernatedShort") : t("notStartedShort");
      if (session.panes.some((pane) => pane.done)) {
        return { tone: "done", glyph: "done", label: `${t("done")} · ${short}` };
      }
      return { tone: "dormant", glyph: "dormant", label: sleeping };
    }
    let best = null;
    for (const pane of session.panes) {
      const status = paneStatus(session, pane);
      if (!best || TONE_RANK[status.tone] > TONE_RANK[best.tone]) best = status;
    }
    if (!best) return { tone: "idle", glyph: "idle", label: t("idle") };
    // The card names the state; the detail lives on the pane row.
    if (best.tone === "waiting") return { tone: "waiting", glyph: "waiting", label: t("waiting") };
    return best;
  }

  function glyph(status) {
    const el = h("span", { class: `dot dot-${status.glyph}`, "aria-hidden": "true" });
    if (status.glyph === "done") {
      el.innerHTML = '<svg viewBox="0 0 12 12"><path d="M2.5 6.3 5 8.6l4.5-5"/></svg>';
    } else if (status.glyph === "dormant") {
      el.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
    }
    return el;
  }

  function statusEl(status, kind) {
    return h(
      "span",
      { class: cx(kind || "st", `tone-${status.tone}`) },
      glyph(status),
      h("span", { class: "st-label", text: status.label }),
    );
  }

  function ago(since) {
    if (!Number.isFinite(since)) return "";
    const seconds = Math.max(0, (pcNow() - since) / 1000);
    if (seconds < 45) return t("agoNow");
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t("agoMin", Math.max(1, minutes));
    const hours = Math.round(minutes / 60);
    if (hours < 24) return t("agoHour", hours);
    return t("agoDay", Math.round(hours / 24));
  }

  function shortPath(cwd) {
    const parts = String(cwd || "").split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 2) return String(cwd || "");
    return `…/${parts.slice(-2).join("/")}`;
  }

  function findPane(paneId) {
    const snapshot = state.snapshot;
    if (!snapshot || !paneId) return null;
    for (const session of snapshot.sessions) {
      for (const pane of session.panes) if (pane.paneId === paneId) return { session, pane };
    }
    return null;
  }

  function isWaking(sessionId) {
    const until = state.waking.get(sessionId);
    if (!until) return false;
    if (Date.now() > until) {
      state.waking.delete(sessionId);
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ views

  const SCREENS = ["boot", "pair", "sessions", "terminal"];

  function show(view) {
    state.view = view;
    for (const name of SCREENS) $(`screen-${name}`).hidden = name !== view;
    const app = $("app");
    for (const name of SCREENS) app.classList.toggle(`view-${name}`, name === view);
    if (view !== "terminal") cancelRecording();
    closeMenu();
  }

  function route() {
    if (!state.device) return;
    const match = /^#\/p\/(.+)$/.exec(location.hash);
    let paneId = null;
    if (match) {
      try {
        paneId = decodeURIComponent(match[1]);
      } catch (error) {
        paneId = null;
      }
    }
    if (paneId !== state.paneId) {
      saveDraft();
      state.paneId = paneId;
      state.screen = null;
      state.follow = true;
      $("term-lines").replaceChildren();
      loadDraft();
    }
    if (paneId) {
      show("terminal");
      renderTerminal();
    } else {
      show("sessions");
      renderSessions();
    }
    connect();
  }

  function openPane(paneId) {
    history.pushState({ ht: "pane" }, "", `#/p/${encodeURIComponent(paneId)}`);
    route();
  }

  function goBack() {
    if (history.state && history.state.ht === "pane") {
      history.back();
    } else {
      history.replaceState(null, "", "#/");
      route();
    }
  }

  // ------------------------------------------------------------------ connection

  let source = null;
  let sourcePane;
  let retryTimer = null;
  let retryDelay = 1000;

  function setConn(conn) {
    state.conn = conn;
    const pill = $("conn-pill");
    pill.dataset.state = conn;
    $("conn-text").textContent = conn === "online" ? t("online") : conn === "offline" ? t("offline") : t("connecting");
    $("term-offline").hidden = conn === "online" || state.view !== "terminal";
    $("term-offline-text").textContent = t("offlineBanner");
  }

  function disconnect() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (source) {
      source.close();
      source = null;
    }
  }

  function connect(force) {
    if (!state.device) return;
    const pane = state.view === "terminal" ? state.paneId : null;
    if (!force && source && sourcePane === pane && source.readyState !== 2) return;
    disconnect();
    sourcePane = pane;
    if (state.conn !== "online") setConn("connecting");
    const url = `/api/events${pane ? `?pane=${encodeURIComponent(pane)}` : ""}`;
    const es = new EventSource(url);
    source = es;
    es.onopen = () => {
      if (source !== es) return;
      retryDelay = 1000;
      setConn("online");
    };
    es.addEventListener("state", (event) => {
      if (source !== es) return;
      setConn("online");
      try {
        onSnapshot(JSON.parse(event.data));
      } catch (error) {
        // A malformed event is dropped; the next one replaces it anyway.
      }
    });
    es.addEventListener("screen", (event) => {
      if (source !== es) return;
      try {
        onScreen(JSON.parse(event.data));
      } catch (error) {
        // Same as above.
      }
    });
    es.addEventListener("bye", () => {
      if (source !== es) return;
      disconnect();
      toPair(t("revoked"));
    });
    es.onerror = () => {
      if (source !== es) return;
      setConn("offline");
      if (es.readyState === 2) {
        // The browser gave up (an HTTP error, e.g. 401): find out why.
        disconnect();
        checkSessionThenRetry();
      }
    };
  }

  async function checkSessionThenRetry() {
    const result = await api("/api/me", { allow401: true });
    if (result.status === 401) {
      toPair(t("revoked"));
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => connect(true), retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  }

  // ------------------------------------------------------------------ incoming

  function onSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.sessions)) return;
    const hadSnapshot = state.snapshot !== null;
    const fresh = [];
    const waiting = new Map();
    for (const session of snapshot.sessions) {
      if (!Array.isArray(session.panes)) session.panes = [];
      if (session.state === "live") state.waking.delete(session.sessionId);
      for (const pane of session.panes) {
        const isWaiting = session.state === "live" && pane.activity === "waiting_input";
        waiting.set(pane.paneId, isWaiting);
        if (isWaiting && hadSnapshot && state.waiting.get(pane.paneId) !== true) fresh.push({ session, pane });
      }
    }
    state.waiting = waiting;
    state.snapshot = snapshot;
    if (fresh.length) {
      if (canVibrate()) {
        try {
          navigator.vibrate(200);
        } catch (error) {
          // Not allowed before the first tap; fine.
        }
      }
      for (const entry of fresh) state.attention.add(entry.pane.paneId);
      const elsewhere = fresh.find((entry) => entry.pane.paneId !== state.paneId);
      if (state.view === "terminal" && elsewhere) {
        toast(t("waitingToast", elsewhere.session.title, elsewhere.pane.index), {
          kind: "attention",
          duration: 6000,
          action: { label: t("open"), run: () => openPane(elsewhere.pane.paneId) },
        });
      }
    }
    updateTitle();
    if (state.view === "sessions") renderSessions();
    else if (state.view === "terminal") renderTerminal();
  }

  function onScreen(screen) {
    if (!screen || screen.paneId !== state.paneId || !Array.isArray(screen.lines)) return;
    state.screen = screen;
    if (state.view === "terminal") renderTerminal();
  }

  function updateTitle() {
    let count = 0;
    for (const value of state.waiting.values()) if (value) count += 1;
    document.title = count ? `(${count}) Head Terminal` : "Head Terminal";
  }

  // ------------------------------------------------------------------ sessions screen

  function renderSessions() {
    const list = $("session-list");
    const snapshot = state.snapshot;
    if (!snapshot) {
      list.replaceChildren(h("div", { class: "empty" }, h("span", { class: "spin" }), h("p", { class: "empty-text", text: t("loadingSessions") })));
      return;
    }
    if (!snapshot.sessions.length) {
      list.replaceChildren(
        h(
          "div",
          { class: "empty" },
          h("span", { class: "empty-icon" }, icon("terminal")),
          h("p", { class: "empty-title", text: t("noSessions") }),
          h("p", { class: "empty-text", text: t("noSessionsHint") }),
        ),
      );
      return;
    }
    // Pinned first; otherwise the desktop's order (sort is stable).
    const sessions = snapshot.sessions.slice().sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
    const scrollTop = list.scrollTop;
    list.replaceChildren(...sessions.map(sessionCard));
    list.scrollTop = scrollTop;
    state.attention.clear();
  }

  function sessionCard(session) {
    const live = session.state === "live";
    const status = sessionStatus(session);
    const waiting = live && session.panes.some((pane) => pane.activity === "waiting_input");
    const title = session.title || shortPath(session.cwd) || "—";
    const meta = [h("span", { class: "path", text: shortPath(session.cwd) })];
    if (session.agentLabel) meta.push(h("span", { text: session.agentLabel }));
    if (session.active) meta.push(h("span", { class: "badge", text: t("onPc") }));

    return h(
      "article",
      { class: cx("card", session.active && "is-active", waiting && "is-waiting", !live && "is-sleeping") },
      h(
        "div",
        { class: "card-head" },
        h(
          "div",
          { class: "card-titles" },
          h("h2", { class: "card-title" }, session.pinned ? icon("pin") : null, h("span", { class: "card-title-text", text: title })),
          h("div", { class: "card-meta" }, meta),
        ),
        statusEl(status, "chip"),
      ),
      session.panes.length
        ? h("ul", { class: "panes" }, session.panes.map((pane) => h("li", null, paneRow(session, pane))))
        : null,
      live
        ? null
        : h(
            "div",
            { class: "card-foot" },
            h("span", { text: session.state === "hibernated" ? t("sleepingFoot") : t("notStartedFoot") }),
            wakeButton(session.sessionId),
          ),
    );
  }

  function paneRow(session, pane) {
    const live = session.state === "live";
    const status = paneStatus(session, pane);
    const since = live ? pane.activitySince : session.hibernatedAt;
    const meta = [statusEl(status)];
    if (Number.isFinite(since)) meta.push(h("span", { class: "ago", "data-since": String(since), text: ago(since) }));
    if (live && Number.isFinite(pane.contextPercent) && pane.contextPercent <= 20) {
      meta.push(h("span", { class: "ctx", text: t("context", Math.round(pane.contextPercent)) }));
    }
    return h(
      "button",
      {
        class: cx("pane-row", status.tone === "waiting" && "is-waiting", state.attention.has(pane.paneId) && "attn"),
        type: "button",
        onclick: () => openPane(pane.paneId),
      },
      h("span", { class: "pane-index", text: String(pane.index) }),
      h(
        "span",
        { class: "pane-main" },
        h("span", { class: "pane-title", text: pane.title || t("terminalN", pane.index) }),
        h("span", { class: "pane-meta" }, meta),
      ),
      icon("chevron"),
    );
  }

  function wakeButton(sessionId) {
    const waking = isWaking(sessionId);
    return h(
      "button",
      {
        class: "btn btn-primary btn-sm",
        type: "button",
        disabled: waking,
        onclick: (event) => {
          event.stopPropagation();
          wake(sessionId);
        },
      },
      waking ? h("span", { class: "spin" }) : icon("sun"),
      t(waking ? "waking" : "wake"),
    );
  }

  async function wake(sessionId) {
    state.waking.set(sessionId, Date.now() + 45000);
    rerender();
    const ok = await command({ type: "wake-session", sessionId });
    if (!ok) state.waking.delete(sessionId);
    rerender();
  }

  function rerender() {
    if (state.view === "sessions") renderSessions();
    else if (state.view === "terminal") renderTerminal();
  }

  function refreshAgo() {
    for (const el of document.querySelectorAll("[data-since]")) {
      el.textContent = ago(Number(el.getAttribute("data-since")));
    }
  }

  // ------------------------------------------------------------------ terminal screen

  const KEYS = [
    { key: "escape", label: () => t("keyEsc") },
    { key: "enter", label: () => t("keyEnter") },
    { key: "up", label: () => "↑" },
    { key: "down", label: () => "↓" },
    { key: "left", label: () => "←" },
    { key: "right", label: () => "→" },
    { key: "tab", label: () => t("keyTab") },
    { key: "shift-tab", label: () => t("keyShiftTab") },
    { key: "1", label: () => "1", hot: true },
    { key: "2", label: () => "2", hot: true },
    { key: "3", label: () => "3", hot: true },
    { key: "y", label: () => "y", hot: true },
    { key: "n", label: () => "n", hot: true },
    { key: "ctrl-c", label: () => t("keyCtrlC"), danger: true },
    { key: "backspace", label: () => "⌫" },
  ];

  function buildKeys() {
    const bar = $("keys");
    bar.replaceChildren(
      ...KEYS.map((entry) =>
        h("button", {
          class: cx("key", entry.danger && "key-danger"),
          type: "button",
          "data-key": entry.key,
          "data-hot": entry.hot ? "1" : null,
          text: entry.label(),
          onpointerdown: keepFocus,
          onclick: () => sendKey(entry.key),
        }),
      ),
    );
  }

  /** Buttons near the composer must not take the focus (and the keyboard). */
  function keepFocus(event) {
    if (document.activeElement === $("composer-input")) event.preventDefault();
  }

  function canVibrate() {
    if (typeof navigator.vibrate !== "function") return false;
    return !navigator.userActivation || navigator.userActivation.hasBeenActive;
  }

  function haptic() {
    if (canVibrate()) {
      try {
        navigator.vibrate(8);
      } catch (error) {
        // Ignored.
      }
    }
  }

  async function sendKey(key) {
    if (!state.paneId) return;
    haptic();
    state.follow = true;
    await command({ type: "send-key", paneId: state.paneId, key });
  }

  function renderTerminal() {
    const found = findPane(state.paneId);
    const title = $("term-title");
    const sessionLabel = $("term-session");
    const statusSlot = $("term-status");
    const empty = $("term-empty");
    const keys = $("keys");
    const composer = $("composer");

    if (found) {
      const { session, pane } = found;
      title.textContent = `${pane.index} · ${pane.title || t("terminalN", pane.index)}`;
      sessionLabel.textContent = session.title || shortPath(session.cwd);
      const status = paneStatus(session, pane);
      statusSlot.replaceWith(Object.assign(statusEl(status), { id: "term-status" }));
      const hot = session.state === "live" && pane.activity === "waiting_input";
      for (const button of keys.querySelectorAll("[data-hot]")) button.classList.toggle("is-hot", hot);
      const hotKey = hot ? `${pane.paneId}:${pane.activitySince}` : null;
      if (hotKey && hotKey !== state.hotKey) {
        const first = keys.querySelector("[data-hot]");
        // After layout: the bar may only now be shown.
        requestAnimationFrame(() => {
          if (first) keys.scrollTo({ left: Math.max(0, first.offsetLeft - 12), behavior: "smooth" });
        });
      }
      state.hotKey = hotKey;
    } else {
      title.textContent = state.snapshot ? t("paneGone") : t("connecting");
      sessionLabel.textContent = "";
      statusSlot.replaceChildren();
    }
    $("term-offline").hidden = state.conn === "online";

    let emptyContent = null;
    let interactive = true;
    if (!state.snapshot) {
      emptyContent = [h("span", { class: "spin" }), h("p", { class: "empty-text", text: t("connecting") })];
      interactive = false;
    } else if (!found) {
      interactive = false;
      emptyContent = [
        h("span", { class: "empty-icon" }, icon("gone")),
        h("p", { class: "empty-title", text: t("paneGone") }),
        h("p", { class: "empty-text", text: t("paneGoneHint") }),
        h("button", { class: "btn", type: "button", onclick: goBack, text: t("backToSessions") }),
      ];
    } else if (found.session.state !== "live") {
      interactive = false;
      const hibernated = found.session.state === "hibernated";
      emptyContent = [
        h("span", { class: "empty-icon" }, icon("moon")),
        h("p", { class: "empty-title", text: hibernated ? t("hibernatedTitle") : t("notStartedTitle") }),
        h("p", { class: "empty-text", text: t("sleepingHint") }),
        wakeButton(found.session.sessionId),
      ];
    } else if (!state.screen) {
      emptyContent = [h("span", { class: "spin" }), h("p", { class: "empty-text", text: t("loadingScreen") })];
    }

    keys.hidden = !interactive;
    composer.hidden = !interactive;
    if (emptyContent) {
      empty.replaceChildren(h("div", { class: "empty" }, emptyContent));
      empty.hidden = false;
      $("live-btn").hidden = true;
    } else {
      empty.hidden = true;
      renderScreen();
    }
    if (!interactive) {
      cancelRecording();
      $("rec-strip").hidden = true;
    }
  }

  // Styles of the screen become classes in a stylesheet built here: the CSP
  // blocks style attributes, not CSSOM.
  let screenSheet = null;
  let sheetTried = false;
  const classByDecl = new Map();
  const MAX_STYLE_CLASSES = 4000;
  const UNSAFE_DECL = /[{}<>@\\]|url\s*\(|expression|import/i;
  const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]{3,20})$/i;

  function styleSheet() {
    if (sheetTried) return screenSheet;
    sheetTried = true;
    try {
      if ("adoptedStyleSheets" in document && typeof CSSStyleSheet === "function") {
        const sheet = new CSSStyleSheet();
        sheet.insertRule(".term .k0{}", 0);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        screenSheet = sheet;
        return sheet;
      }
    } catch (error) {
      screenSheet = null;
    }
    // Older Safari: add the rules to app.css itself.
    for (const sheet of Array.from(document.styleSheets)) {
      if (sheet.href && sheet.href.endsWith("/app.css")) screenSheet = sheet;
    }
    return screenSheet;
  }

  function classFor(decl) {
    if (!decl) return "";
    const known = classByDecl.get(decl);
    if (known !== undefined) return known;
    let name = "";
    const sheet = styleSheet();
    if (sheet && !UNSAFE_DECL.test(decl) && classByDecl.size < MAX_STYLE_CLASSES) {
      name = `k${(classByDecl.size + 1).toString(36)}`;
      try {
        sheet.insertRule(`.term .${name}{${decl}}`, sheet.cssRules.length);
      } catch (error) {
        name = "";
      }
    }
    classByDecl.set(decl, name);
    return name;
  }

  function runNode(text, className) {
    if (!className) return document.createTextNode(text);
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    return span;
  }

  /** Box borders and separators: clipped at the edge rather than wrapped
   * into a second, broken line. */
  // Whitespace and the Box Drawing block (U+2500–U+257F), written literally.
  const RULE_LINE = /^[\s─-╿]{16,}$/;

  function appendRuns(line, runs, styles, cursorCol) {
    let col = 0;
    let plain = "";
    let cursorDone = cursorCol < 0;
    for (const run of runs) {
      if (!Array.isArray(run)) continue;
      const text = typeof run[0] === "string" ? run[0] : String(run[0] ?? "");
      if (!text) continue;
      plain += text;
      const className = classFor(typeof styles[run[1]] === "string" ? styles[run[1]] : "");
      if (!cursorDone && cursorCol >= col && cursorCol < col + text.length) {
        const at = cursorCol - col;
        if (at > 0) line.append(runNode(text.slice(0, at), className));
        line.append(runNode(text[at], cx(className, "cur")));
        if (at + 1 < text.length) line.append(runNode(text.slice(at + 1), className));
        cursorDone = true;
      } else {
        line.append(runNode(text, className));
      }
      col += text.length;
    }
    if (!cursorDone) {
      if (cursorCol > col) line.append(document.createTextNode(" ".repeat(Math.min(cursorCol - col, 1000))));
      line.append(runNode(" ", "cur"));
    }
    if (RULE_LINE.test(plain)) line.classList.add("rule");
  }

  function isNearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 28;
  }

  function renderScreen() {
    const screen = state.screen;
    if (!screen) return;
    const term = $("term");
    const lines = $("term-lines");
    const theme = screen.theme || {};
    const root = document.documentElement.style;
    if (COLOR.test(String(theme.background || ""))) root.setProperty("--term-bg", theme.background);
    if (COLOR.test(String(theme.foreground || ""))) root.setProperty("--term-fg", theme.foreground);

    const follow = state.follow || isNearBottom(term);
    const styles = Array.isArray(screen.styles) ? screen.styles : [];
    const cursor = screen.cursor && Number.isFinite(screen.cursor.line) ? screen.cursor : null;
    const fragment = document.createDocumentFragment();
    const count = Math.max(screen.lines.length, cursor ? cursor.line + 1 : 0);
    for (let index = 0; index < count; index += 1) {
      const line = document.createElement("div");
      line.className = "l";
      const runs = Array.isArray(screen.lines[index]) ? screen.lines[index] : [];
      appendRuns(line, runs, styles, cursor && cursor.line === index ? Math.max(0, cursor.col | 0) : -1);
      fragment.append(line);
    }
    lines.replaceChildren(fragment);
    if (follow) {
      term.scrollTop = term.scrollHeight;
      state.follow = true;
    }
    updateLiveButton();
  }

  function updateLiveButton() {
    $("live-btn").hidden = !state.screen || !$("term-empty").hidden || state.follow;
  }

  function applyTermPrefs() {
    $("term").classList.toggle("nowrap", !prefs.wrap);
    document.documentElement.style.setProperty("--term-font", `${prefs.fontSize}px`);
  }

  // ------------------------------------------------------------------ composer

  // C0 controls but tab/LF/CR, DEL and C1: the server refuses them.
  const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
  const MAX_TEXT = 8000;
  let sending = false;

  function input() {
    return $("composer-input");
  }

  function autosize() {
    const el = input();
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 148)}px`;
    el.style.overflowY = el.scrollHeight + 2 > 148 ? "auto" : "hidden";
  }

  function saveDraft() {
    if (!state.paneId) return;
    const value = input().value;
    if (value) state.drafts.set(state.paneId, value);
    else state.drafts.delete(state.paneId);
  }

  function loadDraft() {
    input().value = (state.paneId && state.drafts.get(state.paneId)) || "";
    autosize();
  }

  async function submitComposer() {
    if (sending || !state.paneId) return;
    const el = input();
    const text = el.value.replace(FORBIDDEN_TEXT, "");
    if (!text.trim()) {
      // An empty send is an Enter: "press Enter to continue".
      if (!text) await sendKey("enter");
      return;
    }
    if (text.length > MAX_TEXT) {
      toast(t("textTooLong"), { kind: "error" });
      return;
    }
    sending = true;
    $("send-btn").disabled = true;
    haptic();
    const paneId = state.paneId;
    const ok = await command({ type: "send-text", paneId, text, submit: prefs.submit });
    sending = false;
    $("send-btn").disabled = false;
    if (ok && state.paneId === paneId) {
      el.value = "";
      state.drafts.delete(paneId);
      autosize();
      state.follow = true;
    }
  }

  function renderEnterToggle() {
    const button = $("enter-toggle");
    button.setAttribute("aria-pressed", prefs.submit ? "true" : "false");
    button.title = t("enterOnSend");
  }

  // ------------------------------------------------------------------ microphone

  const micSupported = !!(
    window.isSecureContext &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof window.MediaRecorder === "function"
  );
  const MAX_RECORDING_MS = 5 * 60 * 1000;
  let recording = null;
  let transcribing = false;

  function pickMimeType() {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];
    if (typeof MediaRecorder.isTypeSupported !== "function") return "";
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  /** What the server accepts: audio/webm|mp4|ogg|wav, parameters allowed. */
  function uploadType(mimeType) {
    const base = String(mimeType || "").split(";")[0].trim().toLowerCase();
    if (base === "audio/webm" || base === "video/webm") return "audio/webm";
    if (base === "audio/mp4" || base === "video/mp4" || base === "audio/x-m4a" || base === "audio/aac") return "audio/mp4";
    if (base === "audio/ogg") return "audio/ogg";
    if (base === "audio/wav" || base === "audio/wave" || base === "audio/x-wav") return "audio/wav";
    return "audio/webm";
  }

  function formatElapsed(ms) {
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  function renderRecording() {
    const strip = $("rec-strip");
    const button = $("mic-btn");
    if (recording) {
      strip.hidden = false;
      strip.classList.remove("is-busy");
      $("rec-text").textContent = t("recording", formatElapsed(Date.now() - recording.startedAt));
      button.classList.add("is-recording");
      setIcon(button, "stop");
      button.setAttribute("aria-label", t("micStop"));
    } else {
      button.classList.remove("is-recording");
      setIcon(button, "mic");
      button.setAttribute("aria-label", t("mic"));
      if (transcribing) {
        strip.hidden = false;
        strip.classList.add("is-busy");
        $("rec-text").textContent = t("transcribing");
      } else {
        strip.hidden = true;
      }
    }
    button.disabled = transcribing;
  }

  async function toggleRecording() {
    if (transcribing) return;
    if (recording) {
      stopRecording(false);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      toast(t("micDenied"), { kind: "error" });
      return;
    }
    let recorder;
    try {
      const type = pickMimeType();
      recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      toast(t("micUnavailable"), { kind: "error" });
      return;
    }
    const chunks = [];
    const current = {
      recorder,
      stream,
      chunks,
      discard: false,
      startedAt: Date.now(),
      timer: setInterval(() => {
        if (recording !== current) return;
        if (Date.now() - current.startedAt >= MAX_RECORDING_MS) stopRecording(false);
        else renderRecording();
      }, 250),
    };
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      clearInterval(current.timer);
      stream.getTracks().forEach((track) => track.stop());
      if (recording === current) recording = null;
      const type = recorder.mimeType || (chunks[0] && chunks[0].type) || "audio/webm";
      const blob = new Blob(chunks, { type });
      renderRecording();
      if (!current.discard && blob.size > 0) transcribe(blob, type);
    };
    recording = current;
    // Small slices: a phone that locks mid-recording still has most of it.
    recorder.start(1000);
    haptic();
    renderRecording();
  }

  function stopRecording(discard) {
    const current = recording;
    if (!current) return;
    current.discard = discard;
    try {
      if (current.recorder.state !== "inactive") current.recorder.stop();
      else current.recorder.onstop();
    } catch (error) {
      current.stream.getTracks().forEach((track) => track.stop());
      recording = null;
      renderRecording();
    }
  }

  function cancelRecording() {
    if (recording) stopRecording(true);
  }

  async function transcribe(blob, mimeType) {
    transcribing = true;
    renderRecording();
    const result = await api("/api/transcribe", { method: "POST", blob, contentType: uploadType(mimeType) });
    transcribing = false;
    renderRecording();
    if (result.status === 401) return;
    if (!result.ok) {
      const message = (result.data && result.data.error) || (result.status ? `HTTP ${result.status}` : t("network"));
      toast(t("transcribeFailed", message), { kind: "error", duration: 5000 });
      return;
    }
    const text = String((result.data && result.data.text) || "").trim();
    if (!text) {
      toast(t("transcribeEmpty"));
      return;
    }
    const el = input();
    const before = el.value;
    el.value = before && !/\s$/.test(before) ? `${before} ${text}` : `${before}${text}`;
    saveDraft();
    autosize();
    toast(t("reviewHint"));
  }

  // ------------------------------------------------------------------ menus

  function closeMenu() {
    $("menu").hidden = true;
    $("menu-scrim").hidden = true;
  }

  function openMenu(items) {
    const menu = $("menu");
    menu.replaceChildren(
      ...items.filter(Boolean).map((item) => {
        if (item.separator) return h("div", { class: "menu-sep", role: "separator" });
        if (item.note) return h("div", { class: "menu-note", text: item.note });
        if (item.element) return item.element;
        return h(
          "button",
          {
            class: cx("menu-item", item.danger && "is-danger"),
            type: "button",
            role: item.checked === undefined ? "menuitem" : "menuitemcheckbox",
            "aria-checked": item.checked === undefined ? null : String(!!item.checked),
            disabled: !!item.disabled,
            onclick: () => {
              if (!item.keepOpen) closeMenu();
              item.run();
            },
          },
          icon(item.icon),
          h("span", { text: item.label }),
          item.checked ? h("span", { class: "check" }, icon("check")) : null,
        );
      }),
    );
    menu.hidden = false;
    $("menu-scrim").hidden = false;
  }

  function fontStepper() {
    const output = h("output", { text: String(prefs.fontSize) });
    const step = (delta) => {
      prefs.fontSize = clamp(prefs.fontSize + delta, FONT_MIN, FONT_MAX);
      storage.set("ht.remote.fontSize", prefs.fontSize);
      output.textContent = String(prefs.fontSize);
      const follow = state.follow;
      applyTermPrefs();
      if (follow) $("term").scrollTop = $("term").scrollHeight;
    };
    return h(
      "div",
      { class: "menu-row" },
      icon("text"),
      h("span", { class: "menu-row-label", text: t("fontSize") }),
      h(
        "span",
        { class: "stepper" },
        h("button", { type: "button", "aria-label": t("smaller"), text: "A−", onclick: () => step(-1) }),
        output,
        h("button", { type: "button", "aria-label": t("bigger"), text: "A+", onclick: () => step(1) }),
      ),
    );
  }

  function openTerminalMenu() {
    const found = findPane(state.paneId);
    const live = !!found && found.session.state === "live";
    openMenu([
      {
        icon: "monitor",
        label: t("showOnPc"),
        disabled: !found,
        run: async () => {
          if (!found) return;
          const ok = await command({ type: "focus-session", sessionId: found.session.sessionId, paneId: found.pane.paneId });
          if (ok) toast(t("shownOnPc"));
        },
      },
      {
        icon: "moon",
        label: t("hibernate"),
        disabled: !live,
        run: async () => {
          if (!found || !window.confirm(t("hibernateConfirm"))) return;
          const ok = await command({ type: "hibernate-session", sessionId: found.session.sessionId });
          if (ok) toast(t("hibernating"));
        },
      },
      { separator: true },
      {
        icon: "wrap",
        label: t("wrap"),
        checked: prefs.wrap,
        run: () => {
          prefs.wrap = !prefs.wrap;
          storage.set("ht.remote.wrap", prefs.wrap);
          applyTermPrefs();
          if (state.follow) $("term").scrollTop = $("term").scrollHeight;
        },
      },
      { element: fontStepper() },
    ]);
  }

  function openSessionsMenu() {
    openMenu([
      state.device ? { note: t("pairedAs", state.device.name) } : null,
      {
        icon: "logout",
        label: t("logout"),
        danger: true,
        run: async () => {
          if (!window.confirm(t("logoutConfirm"))) return;
          await api("/api/logout", { method: "POST", allow401: true });
          state.device = null;
          toPair(null);
        },
      },
    ]);
  }

  // ------------------------------------------------------------------ toast

  let toastTimer = null;

  function toast(text, options = {}) {
    const el = $("toast");
    clearTimeout(toastTimer);
    const children = [h("span", { text })];
    if (options.action) {
      children.push(
        h("button", {
          class: "btn btn-primary",
          type: "button",
          text: options.action.label,
          onclick: () => {
            el.hidden = true;
            options.action.run();
          },
        }),
      );
    }
    el.replaceChildren(...children);
    el.className = cx("toast", !options.action && "is-plain", options.kind && `is-${options.kind}`);
    el.hidden = false;
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, options.duration || 3000);
  }

  // ------------------------------------------------------------------ pairing

  let pairBusy = false;

  async function guessDeviceName() {
    const ua = navigator.userAgent || "";
    let device = t("thisDevice");
    if (/iPhone/.test(ua)) device = "iPhone";
    else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) device = "iPad";
    else if (/Android/.test(ua)) {
      device = "Android";
      const model = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?\)/.exec(ua);
      if (model && model[1].trim() && model[1].trim() !== "K") device = model[1].trim();
    } else if (/Windows/.test(ua)) device = "Windows";
    else if (/Mac OS X/.test(ua)) device = "Mac";
    else if (/Linux/.test(ua)) device = "Linux";
    try {
      const data = navigator.userAgentData;
      if (data && typeof data.getHighEntropyValues === "function") {
        const values = await data.getHighEntropyValues(["model"]);
        if (values && values.model) device = values.model;
      }
    } catch (error) {
      // Not available: the UA guess stands.
    }
    const browser = /EdgA?\/|Edg\//.test(ua)
      ? "Edge"
      : /SamsungBrowser/.test(ua)
        ? "Samsung Internet"
        : /Firefox|FxiOS/.test(ua)
          ? "Firefox"
          : /CriOS|Chrome\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "";
    return browser ? `${device} · ${browser}` : device;
  }

  function pairError(message) {
    const el = $("pair-error");
    el.textContent = message || "";
    el.hidden = !message;
  }

  function setPairBusy(busy) {
    pairBusy = busy;
    const button = $("pair-submit");
    button.disabled = busy;
    button.replaceChildren(...(busy ? [h("span", { class: "spin" }), t("pairing")] : [t("pairButton")]));
  }

  function toPair(message) {
    disconnect();
    state.device = null;
    state.snapshot = null;
    state.screen = null;
    state.paneId = null;
    state.waiting = new Map();
    updateTitle();
    show("pair");
    pairError(message);
    const name = $("name-input");
    if (!name.value) name.value = state.defaultName;
    const pin = $("pin-input");
    pin.value = "";
    if (window.matchMedia && window.matchMedia("(hover: hover)").matches) pin.focus();
  }

  async function submitPair(event) {
    if (event) event.preventDefault();
    if (pairBusy) return;
    const pin = $("pin-input").value.replace(/\D/g, "");
    if (pin.length !== 6) {
      pairError(t("pinIncomplete"));
      return;
    }
    const name = $("name-input").value.trim() || state.defaultName || t("thisDevice");
    pairError(null);
    setPairBusy(true);
    const result = await api("/api/pair", { method: "POST", body: { pin, name }, allow401: true });
    setPairBusy(false);
    if (result.ok && result.data && result.data.device) {
      $("pin-input").value = "";
      $("pin-input").blur();
      startApp(result.data.device, result.response);
      toast(t("paired"));
      return;
    }
    if (result.status === 429) {
      const ms = (result.data && result.data.retryAfterMs) || 600000;
      pairError(t("pinLocked", Math.max(1, Math.ceil(ms / 60000))));
    } else if (result.status === 401) {
      pairError(t("pinWrong"));
      $("pin-input").select();
    } else if (result.status === 0) {
      pairError(t("network"));
    } else {
      pairError(t("pairFailed"));
    }
  }

  function onPinInput() {
    const el = $("pin-input");
    const digits = el.value.replace(/\D/g, "").slice(0, 6);
    if (digits !== el.value) el.value = digits;
    if (digits.length === 6) submitPair();
    else pairError(null);
  }

  // ------------------------------------------------------------------ viewport

  /** Keeps the app inside the visual viewport, i.e. above the keyboard. */
  function syncViewport() {
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    const root = document.documentElement.style;
    root.setProperty("--app-h", `${Math.round(height)}px`);
    root.setProperty("--app-top", `${Math.round(top)}px`);
    const keyboard = window.innerHeight - height > 120 || document.activeElement === input();
    $("app").classList.toggle("kb-open", keyboard);
    if (state.view === "terminal" && state.follow) {
      const term = $("term");
      term.scrollTop = term.scrollHeight;
    }
  }

  // ------------------------------------------------------------------ boot

  function applyStaticText() {
    document.documentElement.lang = LANG === "pt" ? "pt-BR" : "en";
    for (const el of document.querySelectorAll("[data-t]")) el.textContent = t(el.getAttribute("data-t"));
    for (const el of document.querySelectorAll("[data-t-aria]")) {
      const label = t(el.getAttribute("data-t-aria"));
      el.setAttribute("aria-label", label);
      el.title = label;
    }
    setIcon($("sessions-menu-btn"), "more");
    setIcon($("term-back"), "back");
    setIcon($("term-menu-btn"), "more");
    setIcon($("enter-toggle"), "enter");
    setIcon($("mic-btn"), "mic");
    setIcon($("send-btn"), "send");
    $("live-btn").replaceChildren(icon("down"), h("span", { text: t("live") }));
    input().placeholder = micSupported ? t("placeholder") : t("placeholderNoMic");
    $("mic-btn").hidden = !micSupported;
  }

  function wire() {
    $("pair-form").addEventListener("submit", submitPair);
    $("pin-input").addEventListener("input", onPinInput);
    $("boot-retry").addEventListener("click", () => boot());

    $("sessions-menu-btn").addEventListener("click", openSessionsMenu);
    $("term-menu-btn").addEventListener("click", openTerminalMenu);
    $("term-back").addEventListener("click", goBack);
    $("menu-scrim").addEventListener("click", closeMenu);

    const term = $("term");
    let lastScrollTop = 0;
    term.addEventListener(
      "scroll",
      () => {
        if (isNearBottom(term)) state.follow = true;
        else if (term.scrollTop < lastScrollTop - 1) state.follow = false;
        lastScrollTop = term.scrollTop;
        updateLiveButton();
      },
      { passive: true },
    );
    if (typeof window.ResizeObserver === "function") {
      new ResizeObserver(() => {
        if (state.follow) term.scrollTop = term.scrollHeight;
      }).observe(term);
    }
    // Tapping the screen puts the keyboard away so there is room to read.
    term.addEventListener("click", () => {
      if (document.activeElement === input() && !window.getSelection().toString()) input().blur();
    });
    $("live-btn").addEventListener("click", () => {
      state.follow = true;
      term.scrollTop = term.scrollHeight;
      updateLiveButton();
    });

    const composer = $("composer");
    composer.addEventListener("submit", (event) => {
      event.preventDefault();
      submitComposer();
    });
    const field = input();
    field.addEventListener("input", () => {
      autosize();
      saveDraft();
    });
    // A hardware keyboard: Enter sends, Shift+Enter is a new line. On a
    // touch keyboard Enter stays a new line and the button sends.
    const finePointer = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)");
    field.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      if ((finePointer && finePointer.matches && !event.shiftKey) || event.ctrlKey || event.metaKey) {
        event.preventDefault();
        submitComposer();
      }
    });
    field.addEventListener("focus", syncViewport);
    field.addEventListener("blur", () => {
      setTimeout(syncViewport, 50);
      // iOS leaves the page scrolled after the keyboard goes away.
      if (window.scrollY) window.scrollTo(0, 0);
    });
    for (const id of ["send-btn", "mic-btn", "enter-toggle"]) $(id).addEventListener("pointerdown", keepFocus);
    $("mic-btn").addEventListener("click", toggleRecording);
    $("enter-toggle").addEventListener("click", () => {
      prefs.submit = !prefs.submit;
      storage.set("ht.remote.submit", prefs.submit);
      renderEnterToggle();
      toast(prefs.submit ? t("enterOn") : t("enterOff"));
    });

    window.addEventListener("popstate", route);
    window.addEventListener("hashchange", route);
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("menu").hidden) closeMenu();
    });

    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", syncViewport);
      window.visualViewport.addEventListener("scroll", syncViewport);
    }
    window.addEventListener("resize", syncViewport);
    window.addEventListener("orientationchange", () => setTimeout(syncViewport, 250));

    // A phone that slept may hold a stream that is silently dead.
    let hiddenAt = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }
      if (!state.device) return;
      refreshAgo();
      if (Date.now() - hiddenAt > 5000 || !source || source.readyState !== 1) connect(true);
    });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted && state.device) connect(true);
    });
    window.addEventListener("online", () => {
      if (state.device) connect(true);
    });

    setInterval(() => {
      if (!document.hidden) refreshAgo();
    }, 30000);
  }

  function readSkew(response) {
    const date = response && response.headers && Date.parse(response.headers.get("Date") || "");
    if (Number.isFinite(date)) state.skew = Date.now() - date;
  }

  function startApp(device, response) {
    state.device = device;
    readSkew(response);
    if (!location.hash.startsWith("#/p/") && location.hash !== "#/") history.replaceState(null, "", "#/");
    route();
  }

  /** `#pair=123456` from the QR code in Settings; read once and dropped from
   * the address bar so the PIN does not stay in the history. */
  function takePairFromHash() {
    const hash = location.hash || "";
    if (!/(^#|[#&])pair=/.test(hash)) return null;
    const match = /(?:^#|[#&])pair=(\d{6})(?:&|$)/.exec(hash);
    history.replaceState(null, "", location.pathname + location.search);
    return match ? match[1] : null;
  }

  const pendingPin = takePairFromHash();
  let pendingPinUsed = false;

  async function boot() {
    show("boot");
    $("boot-retry").hidden = true;
    $("boot-text").textContent = t("connecting");
    const result = await api("/api/me", { allow401: true });
    if (result.ok && result.data && result.data.device) {
      startApp(result.data.device, result.response);
      return;
    }
    if (result.status === 401) {
      toPair(null);
      if (pendingPin && !pendingPinUsed) {
        pendingPinUsed = true;
        if (!state.defaultName) state.defaultName = await guessDeviceName();
        if (!$("name-input").value) $("name-input").value = state.defaultName;
        $("pin-input").value = pendingPin;
        submitPair();
      }
      return;
    }
    $("boot-text").textContent = t("cantConnect");
    $("boot-retry").hidden = false;
  }

  applyStaticText();
  buildKeys();
  renderEnterToggle();
  applyTermPrefs();
  wire();
  syncViewport();
  setConn("connecting");
  guessDeviceName().then((name) => {
    state.defaultName = name;
    const field = $("name-input");
    if (!field.value) field.value = name;
  });
  boot();
})();
