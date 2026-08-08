/* Background worker — the one place allowed to talk to the collector.
 *
 * The game is served over https and the collector listens on plain http at
 * localhost, which a content script may not mix: the browser blocks the request
 * before it is made. An extension worker has its own origin and is not subject
 * to that, so every batch goes out from here and the content script only ever
 * talks to this.
 */
(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  const DEFAULT_URL = "http://localhost:8765/rounds";

  async function post(url, records) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records }),
      });
      if (!res.ok) return { ok: false, error: `the collector answered ${res.status}` };
      const body = await res.json();
      // Only a reply that says the rounds were stored may be treated as sent —
      // anything else and the content script has to keep them and try again.
      return body && body.ok ? { ...body, ok: true } : { ok: false, error: "the collector refused the batch" };
    } catch (err) {
      const why = err && err.message ? err.message : String(err);
      return { ok: false, error: `could not reach ${url} — ${why}` };
    }
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "export") return;
    post(msg.url || DEFAULT_URL, msg.records || []).then(sendResponse, (err) =>
      sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
    return true;
  });
})();
