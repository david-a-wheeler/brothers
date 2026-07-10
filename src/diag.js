/**
 * Lightweight diagnostics + problem reporting, so a non-expert player can hand us
 * a useful bug report and so we can retrieve logs at any time.
 *
 * What it does:
 *  - Captures every uncaught error and unhandled promise rejection (global
 *    handlers), plus breadcrumbs we record along the way, into a rolling log that
 *    is mirrored to localStorage — so it survives a reload or a frozen frame.
 *  - On an error, shows a small DOM banner ("Something went wrong. Copy problem
 *    report") that copies a plain-text report to the clipboard. Built from DOM
 *    APIs + CSS classes (no inline styles/handlers), so it works under a strict
 *    CSP and even when the game canvas is dead.
 *  - Is always reachable: open the site with `#diag`, call {@link showReport}
 *    (the in-game "Report a problem" menu item), or `window.__diag.report()` in
 *    the console.
 *  - {@link guard} wraps a callback so an exception is logged instead of bubbling
 *    into Phaser's step/resize/shutdown and killing the render loop.
 *
 * No data leaves the page on its own: reporting is copy-to-clipboard only.
 */

const LS_KEY = 'brothers:diag';
const TRACE_KEY = 'brothers:trace'; // the trace ring, mirrored for post-mortem reads
const DEBUG_KEY = 'brothers:debug'; // persisted console-trace toggle
const MAX_ENTRIES = 60; // rolling breadcrumb/error log length
const MAX_DETAIL = 2000; // per-entry detail cap (chars) so storage stays small
const MAX_TRACE = 120; // rolling verbose-trace ring (in-memory flight recorder)
// Traces fire far more often than log entries, so mirroring every one to
// localStorage would stringify the whole ring on each discrete event. Write at
// most this often; an error() flushes immediately, so a crash never loses tail.
const TRACE_PERSIST_MS = 1000;

/** @type {Array<{t:string, kind:string, message:string, detail?:string, count?:number}>} */
let log = [];
/** @type {Array<{t:string, category:string, message:string, detail?:string}>} Verbose
 *  trace ring (in-memory only; included in {@link report} as a flight recorder). */
let traceLog = [];
/** @type {Array<{t:string, category:string, message:string, detail?:string}>} The
 *  trace ring recovered from the previous page life (see {@link loadPersisted}). */
let priorTraceLog = [];
/** When {@link persistTrace} last wrote, for its throttle. */
let lastTracePersist = 0;
/** When true, {@link trace} also mirrors to the console (`?debug` / setDebug). */
let debugEnabled = false;
let installed = false;
/** @type {HTMLElement|null} The one-at-a-time error banner. */
let banner = null;

/** App version for the report. Set a `<meta name="build" content="…">` in
 *  index.html (e.g. at deploy) to stamp a real commit; defaults to "dev". */
function appVersion() {
  try {
    return document.querySelector('meta[name="build"]')?.content || 'dev';
  } catch {
    return 'dev';
  }
}

function loadPersisted() {
  try {
    log = JSON.parse(localStorage.getItem(LS_KEY) || '[]') || [];
  } catch {
    log = [];
  }
  // The trace ring from the *previous* page life. Kept separate from this run's
  // ring (below) so a reload doesn't make stale events look current, but still
  // reportable — that's the whole point of persisting it.
  try {
    priorTraceLog = JSON.parse(localStorage.getItem(TRACE_KEY) || '[]') || [];
  } catch {
    priorTraceLog = [];
  }
}

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(log.slice(-MAX_ENTRIES)));
  } catch {
    // Storage full/unavailable: keep the in-memory log only.
  }
}

/**
 * Mirror the trace ring to storage so it survives a reload or a frame that
 * never comes back. Throttled (see {@link TRACE_PERSIST_MS}); pass `force` to
 * flush now — {@link error} does, so the events leading up to a crash are kept.
 *
 * @param {boolean} [force]
 * @returns {void}
 */
function persistTrace(force) {
  const now = Date.now();
  if (!force && now - lastTracePersist < TRACE_PERSIST_MS) return;
  lastTracePersist = now;
  try {
    localStorage.setItem(TRACE_KEY, JSON.stringify(traceLog.slice(-MAX_TRACE)));
  } catch {
    // Storage full/unavailable: keep the in-memory ring only.
  }
}

/**
 * Append a log entry. Consecutive identical entries are coalesced into a count,
 * so a repeating error (e.g. one thrown on every resize event of a drag) can't
 * flood the log.
 *
 * @param {string} kind  'error' | 'info'
 * @param {string} message
 * @param {string} [detail]
 * @returns {void}
 */
function add(kind, message, detail) {
  const last = log[log.length - 1];
  if (last && last.kind === kind && last.message === message && last.detail === detail) {
    last.count = (last.count || 1) + 1;
    last.t = new Date().toISOString();
  } else {
    log.push({ t: new Date().toISOString(), kind, message, detail });
    if (log.length > MAX_ENTRIES) log = log.slice(-MAX_ENTRIES);
  }
  persist();
}

/** Normalize any thrown value to a stack/message string, capped. */
function detailOf(err) {
  if (err == null) return undefined;
  let s;
  if (typeof err === 'string') s = err;
  else if (err.stack) {
    // Firefox's stack omits the message line, so prepend it when it's not there
    // (Chrome already includes it) — otherwise the report loses the actual error.
    const stack = String(err.stack);
    const msg = err.message ? String(err.message) : '';
    s = msg && !stack.includes(msg) ? `${msg}\n${stack}` : stack;
  } else if (err.message) s = String(err.message);
  else {
    try {
      s = JSON.stringify(err);
    } catch {
      s = String(err);
    }
  }
  return s.length > MAX_DETAIL ? s.slice(0, MAX_DETAIL) + '…' : s;
}

/**
 * Record a non-error breadcrumb (scene changes, key actions) for context.
 *
 * @param {string} message @param {string} [detail] @returns {void}
 */
export function breadcrumb(message, detail) {
  add('info', String(message), detail && detailOf(detail));
}

/** Compact stringify for trace context, capped. @param {*} v @returns {string} */
function traceStr(v) {
  let s;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s && s.length > MAX_DETAIL ? s.slice(0, MAX_DETAIL) + '…' : s;
}

/**
 * Verbose gesture/state trace. Always kept in a small in-memory ring, so recent
 * events land in the problem report as a flight recorder — invaluable for the
 * "an expected action silently didn't happen" class of bug (no error to catch).
 * Also mirrored to the console when debug is on (open with `?debug`, or call
 * `__diag.setDebug(true)`). Cheap and safe to sprinkle on *discrete* events —
 * input, navigation, suppressed guards — but NOT per-frame (it's not for the loop).
 *
 * @param {string} category  Short area tag, e.g. 'input'.
 * @param {string} message
 * @param {*} [data]  Small structured context (positions, flags, …).
 * @returns {void}
 */
export function trace(category, message, data) {
  traceLog.push({
    t: new Date().toISOString(),
    category: String(category),
    message: String(message),
    detail: data === undefined ? undefined : traceStr(data),
  });
  if (traceLog.length > MAX_TRACE) traceLog.shift();
  persistTrace();
  if (debugEnabled) console.debug(`[trace:${category}] ${message}`, data === undefined ? '' : data);
}

/** Turn the console trace mirror on/off (persisted across reloads). @param {boolean} on @returns {void} */
export function setDebug(on) {
  debugEnabled = !!on;
  try {
    localStorage.setItem(DEBUG_KEY, debugEnabled ? 'true' : 'false');
  } catch {
    // Storage unavailable: honour it for this session only.
  }
}

/** @returns {boolean} Whether console trace-mirroring is on. */
export function isDebug() {
  return debugEnabled;
}

/**
 * Record an error and surface the report banner.
 *
 * @param {string} message  A label for where it happened.
 * @param {unknown} [err]   The thrown value (Error, string, …).
 * @returns {void}
 */
export function error(message, err) {
  add('error', String(message), detailOf(err));
  persistTrace(true); // keep the events that led here, even if the loop dies now
  try {
    showBanner();
  } catch {
    // Never let reporting throw (it would recurse through the global handler).
  }
}

/**
 * Wrap `fn` so a thrown exception is logged (and the banner shown) instead of
 * propagating. Use it on callbacks that run inside Phaser's game step — resize,
 * lifecycle, per-frame — where an unguarded throw kills the render loop.
 *
 * @template {Function} F
 * @param {string} label  Where this runs, for the log.
 * @param {F} fn
 * @returns {F}
 */
export function guard(label, fn) {
  return /** @type {F} */ (
    function (...args) {
      try {
        return fn.apply(this, args);
      } catch (e) {
        error(label, e);
      }
    }
  );
}

/**
 * The full plain-text problem report: environment + the log (most recent last).
 *
 * @returns {string}
 */
export function report() {
  const env = [
    'Brothers — problem report',
    `when:      ${new Date().toString()}`,
    `version:   ${appVersion()}`,
    `url:       ${location.href}`,
    `browser:   ${navigator.userAgent}`,
    `viewport:  ${window.innerWidth}x${window.innerHeight} @ dpr ${window.devicePixelRatio}`,
    `language:  ${navigator.language}`,
    `online:    ${navigator.onLine}`,
  ].join('\n');
  const lines = log.map((e) => {
    const times = e.count && e.count > 1 ? ` (x${e.count})` : '';
    const head = `[${e.t}] ${e.kind.toUpperCase()}${times} ${e.message}`;
    return e.detail ? `${head}\n    ${e.detail.replace(/\n/g, '\n    ')}` : head;
  });
  const traceFmt = (e) => {
    const head = `[${e.t}] ${e.category} ${e.message}`;
    return e.detail ? `${head}  ${e.detail}` : head;
  };
  const traceLines = traceLog.map(traceFmt);
  // Only worth showing when this run has barely started (a reload right after
  // the problem); otherwise it's noise from a session already reported on.
  const prior =
    priorTraceLog.length && traceLog.length < MAX_TRACE
      ? `\n\n--- trace from the previous page load ---\n${priorTraceLog.map(traceFmt).join('\n')}`
      : '';
  return (
    `${env}\n\n--- log (most recent last) ---\n${lines.join('\n') || '(no events recorded)'}` +
    `\n\n--- trace (recent last) ---\n${traceLines.join('\n') || '(none)'}${prior}`
  );
}

/** Clear the stored log and both trace rings. @returns {void} */
export function clear() {
  log = [];
  traceLog = [];
  priorTraceLog = [];
  persist();
  persistTrace(true);
}

/**
 * Copy the report to the clipboard; returns whether it succeeded (clipboard can
 * be blocked outside a secure context or without permission).
 *
 * @returns {Promise<boolean>}
 */
export async function copyReport() {
  const text = report();
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The on-error banner: a message + a "Copy problem report" button. Only one at a
 * time. Copy failure falls back to the full-screen report view so the player can
 * still select the text by hand.
 *
 * @returns {void}
 */
function showBanner() {
  if (banner) return;
  banner = document.createElement('div');
  banner.className = 'diag-banner';

  const msg = document.createElement('span');
  msg.className = 'diag-msg';
  msg.textContent = '⚠ Something went wrong.';

  const copy = document.createElement('button');
  copy.textContent = 'Copy problem report';
  copy.addEventListener('click', async () => {
    const ok = await copyReport();
    if (ok) copy.textContent = 'Copied! Paste problem report and send.';
    else showReport(); // clipboard blocked: show it for manual copy
  });

  const close = document.createElement('button');
  close.className = 'diag-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '✕';
  close.addEventListener('click', () => {
    banner?.remove();
    banner = null;
  });

  banner.append(msg, copy, close);
  document.body.append(banner);
}

/**
 * Full report view: a read-only textarea with the report plus Copy / Close. Used
 * by the "Report a problem" menu item, the `#diag` URL, and as the clipboard
 * fallback. @returns {void}
 */
export function showReport() {
  const overlay = document.createElement('div');
  overlay.className = 'diag-overlay';

  const box = document.createElement('div');
  box.className = 'diag-box';

  const title = document.createElement('div');
  title.className = 'diag-title';
  title.textContent = 'Problem report';

  const help = document.createElement('div');
  help.className = 'diag-help';
  help.textContent = 'Copy this and send it to David so he can see what happened.';

  const ta = document.createElement('textarea');
  ta.className = 'diag-text';
  ta.readOnly = true;
  ta.value = report();

  const bar = document.createElement('div');
  bar.className = 'diag-bar';
  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    ta.focus();
    ta.select();
    const ok = await copyReport();
    copy.textContent = ok ? 'Copied' : 'Press Ctrl/Cmd+C to copy';
  });
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.addEventListener('click', () => overlay.remove());
  bar.append(copy, close);

  box.append(title, help, ta, bar);
  overlay.append(box);
  document.body.append(overlay);
  ta.focus();
  ta.select();
}

/**
 * Install the global capture. Idempotent; call once as early as possible.
 *
 * @returns {void}
 */
export function install() {
  if (installed) return;
  installed = true;
  loadPersisted();

  // Console trace mirror is on if the URL asks (`?debug` / `#debug`) or it was
  // toggled on before. The trace ring records regardless, so a report is always
  // a flight recorder — this flag only controls the live console echo.
  try {
    debugEnabled = /\bdebug\b/i.test(location.search + location.hash) || localStorage.getItem(DEBUG_KEY) === 'true';
  } catch {
    debugEnabled = false;
  }

  window.addEventListener('error', (ev) => {
    // Use the human-readable message as the label; ev.error is null for
    // cross-origin "Script error.", so fall back to the location fields.
    error(ev.message || 'window.onerror', ev.error || `${ev.message} @ ${ev.filename}:${ev.lineno}:${ev.colno}`);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    error('unhandledrejection', ev.reason);
  });

  // Expose for console use and open the report if the URL asks for it.
  window.__diag = { report, show: showReport, clear, setDebug, isDebug, trace };
  if (String(location.hash).toLowerCase().includes('diag')) showReport();
}
