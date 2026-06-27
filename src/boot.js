/**
 * Resilient loader for the game.
 *
 * Kept as an external module (no inline script in index.html) so the page stays
 * compatible with a strict Content-Security-Policy. This tiny file is the only
 * request that isn't retry-protected; it then loads the rest of the app — the
 * larger, multi-file module graph that's the likeliest to hit a transient
 * failure — with bounded retries.
 *
 * On failure we do a full-page reload rather than re-`import()`-ing: a reload
 * yields a clean module graph, whereas browsers cache module-load *failures*
 * for the life of the document, so a per-module retry would just refail. The
 * attempt counter lives in sessionStorage, so it resets when the tab closes and
 * can never loop forever. If retries are exhausted we show a Reload button
 * instead of a blank screen.
 */
const MAX_RELOADS = 3;
const KEY = 'brothers-boot-reloads';

try {
  await import('./main.js');
  sessionStorage.removeItem(KEY); // booted cleanly; reset the counter
} catch (err) {
  console.error('Brothers failed to load:', err);
  const tries = Number(sessionStorage.getItem(KEY) || 0);
  if (tries < MAX_RELOADS) {
    sessionStorage.setItem(KEY, String(tries + 1));
    await new Promise((r) => setTimeout(r, 300 * (tries + 1))); // brief backoff
    location.reload();
  } else {
    sessionStorage.removeItem(KEY);
    showLoadError();
  }
}

/**
 * Replace the game area with a friendly error + Reload button. Built with DOM
 * APIs and a CSS class (no inline styles or handlers) so it works under CSP.
 *
 * @returns {void}
 */
function showLoadError() {
  const host = document.getElementById('game');
  if (!host) return;
  host.textContent = '';

  const box = document.createElement('div');
  box.className = 'load-error';
  box.append("Couldn't load the game.");

  const button = document.createElement('button');
  button.textContent = 'Reload';
  button.addEventListener('click', () => location.reload());
  box.append(button);

  host.append(box);
}
