/* Popup UI — talks to the content script running on tronpick.io/gems.php */
(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;

  const NUM_FIELDS = [
    "minBalance",
    "lowBalanceAt",
    "stopOnProfit",
    "stopOnLoss",
    "maxRounds",
    "roundDelay",
  ];
  const TEXT_FIELDS = ["betAmount", "lowBet"];
  const $ = (id) => document.getElementById(id);

  // The panel on the page can be running happily while this popup cannot reach
  // it: they are the same extension, but Safari grants each installed copy its
  // own access to a site, and a popup belonging to a copy that has not been
  // granted tronpick.io talks to nobody. Saying "not running" sent the last
  // reader looking at the play loop, which was never the thing at fault.
  const NO_REPLY =
    "No reply from the page.\n\n" +
    "If the panel on the page is working, this popup\n" +
    "belongs to a copy of the extension that cannot\n" +
    "reach it. In Safari › Settings › Extensions:\n\n" +
    "  · turn off any duplicate Gems Autoplay\n" +
    "  · give the one that is left access to\n" +
    "    tronpick.io and to localhost\n" +
    "  · quit Safari, reopen, reload the page\n\n" +
    "If there is no panel either, the content script\n" +
    "is not running on this tab.";
  let tabId = null;
  let connected = false;
  let poll = null;
  // Whether the form has been filled in from the page's own config yet. Until
  // it has, the checkboxes read as unticked because that is the HTML default —
  // and sending that on Start would quietly switch off whatever they control.
  let loaded = false;

  function num(id, fallback = 0) {
    const v = parseFloat(($(id).value || "").trim());
    return Number.isFinite(v) ? v : fallback;
  }

  function readConfig() {
    return {
      betAmount: ($("betAmount").value || "").trim(),
      lowBet: ($("lowBet").value || "").trim(),
      lowBalanceAt: num("lowBalanceAt"),
      minBalance: num("minBalance"),
      stopOnProfit: num("stopOnProfit"),
      stopOnLoss: num("stopOnLoss"),
      maxRounds: num("maxRounds"),
      roundDelay: num("roundDelay", 900) || 900,
      hud: $("hud").checked,
      keepAwake: $("keepAwake").checked,
      recordTiles: $("recordTiles").checked,
    };
  }

  function fillConfig(cfg) {
    // The poll must not overwrite a field while it is being edited — but only
    // that field, and never the first fill. Standing down whenever anything at
    // all had focus meant a popup that reopened with focus restored to the box
    // you last ticked was never filled in at all: it sat there showing the
    // markup's own defaults, every checkbox clear, while the page's config said
    // otherwise. Ticking it again then changed nothing, because nothing had
    // changed, so the tick did not even raise an event.
    const busy = loaded && document.activeElement;
    const held = (id) => busy && document.activeElement === $(id);
    for (const f of TEXT_FIELDS) if (!held(f)) $(f).value = cfg[f] || "";
    for (const f of NUM_FIELDS) if (!held(f)) $(f).value = cfg[f] ? String(cfg[f]) : "";
    if (!held("hud")) $("hud").checked = cfg.hud !== false;
    if (!held("keepAwake")) $("keepAwake").checked = cfg.keepAwake !== false;
    if (!held("recordTiles")) $("recordTiles").checked = cfg.recordTiles !== false;
    loaded = true;
  }

  // The reply is given up on after a moment. The content script keeps the
  // message channel open for an asynchronous answer, so a handler that throws
  // before answering leaves this callback hanging for good — and a promise that
  // never settles shows as a button that does nothing at all.
  function send(msg, timeout = 4000) {
    return new Promise((resolve) => {
      if (tabId === null) return resolve(null);
      let done = false;
      const settle = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      setTimeout(() => settle(null), timeout);
      try {
        api.tabs.sendMessage(tabId, msg, (resp) => {
          void api.runtime.lastError;
          settle(resp || null);
        });
      } catch (_) {
        settle(null);
      }
    });
  }

  // Nothing a button does may end in silence: an exception here would otherwise
  // leave the popup looking like it ignored the click.
  function onClick(id, fn) {
    $(id).addEventListener("click", async () => {
      try {
        await fn();
      } catch (err) {
        show(`The popup hit an error: ${err && err.message ? err.message : err}`);
      }
    });
  }

  function render(state) {
    if (!state || state.standDown) {
      connected = false;
      $("status").textContent = state
        ? "Another copy of this extension owns this tab — turn one off in Safari › Settings › Extensions."
        : "Open https://tronpick.io/gems.php in this tab, then reopen this popup.";
      $("toggle").disabled = true;
      return;
    }
    connected = true;
    $("toggle").disabled = false;
    $("dot").classList.toggle("on", state.running);
    $("status").textContent = state.status || (state.running ? "Running" : "Idle");

    const s = state.stats;
    $("s-rounds").textContent = String(s.rounds);
    $("s-wl").textContent = `${s.wins} / ${s.busts}`;
    $("s-picks").textContent = `${s.firstPickLosses} / ${s.secondPickLosses}`;
    $("s-bal").textContent = s.balance === null ? "–" : s.balance.toFixed(6);
    const net = $("s-net");
    net.textContent = s.net === null ? "–" : (s.net >= 0 ? "+" : "") + s.net.toFixed(6);
    net.className = s.net === null ? "" : s.net >= 0 ? "pos" : "neg";

    // How many rounds have reached the collector, and how many are still
    // waiting. What it makes of them is Tile report's job.
    const t2 = state.tiles || {};
    $("s-hit").textContent =
      t2.sending === false
        ? `holding ${t2.unsent}`
        : t2.rounds !== undefined && t2.sending
          ? `${t2.rounds}${t2.unsent ? ` +${t2.unsent}` : ""}`
          : t2.unsent
            ? `${t2.unsent} waiting`
            : "–";

    const t = $("toggle");
    t.textContent = state.running ? "Pause" : "Start";
    t.className = state.running ? "no" : "go";
    fillConfig(state.cfg || {});
  }

  async function refresh() {
    render(await send({ type: "getState" }));
  }

  onClick("toggle", async () => {
    if (!connected) return;
    const state = await send({ type: "getState" });
    if (state && state.running) {
      render(await send({ type: "stop" }));
    } else {
      render(await send({ type: "start", config: loaded ? readConfig() : null }));
    }
  });

  onClick("reset", async () => render(await send({ type: "resetStats" })));

  onClick("diagnose", async () => {
    const info = await send({ type: "diagnose" });
    show(
      info
        ? JSON.stringify(info, null, 1)
        : NO_REPLY
    );
  });

  function show(text) {
    const out = $("out");
    out.classList.add("show");
    out.textContent = text;
  }

  onClick("tiles", async () => {
    const r = await send({ type: "tileReport" });
    show(r ? r.text : NO_REPLY);
  });

  // Safari's extension popup often refuses the async clipboard API — and has
  // been known to leave the promise hanging rather than reject it, so it is
  // raced against the clock before the old selection-based copy is tried.
  async function copyText(text) {
    try {
      const ok = await Promise.race([
        navigator.clipboard.writeText(text).then(() => true),
        new Promise((r) => setTimeout(() => r(false), 1200)),
      ]);
      if (ok) return true;
    } catch (_) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  // The raw log, for working on it outside the extension.
  onClick("copyTiles", async () => {
    const r = await send({ type: "tileData" });
    if (!r) return show(NO_REPLY);
    if (r.standDown) return show(r.text);
    // Worth copying even with nothing recorded: what it carries then is the
    // recorder's account of why, which is the more useful half.
    if (!r.rounds && !r.recent) {
      return show("Nothing to copy — no round has finished yet. Run a few.");
    }
    if (await copyText(r.json)) {
      return show(
        `Copied ${r.rounds} recorded rounds, notes on the last ${r.recent}, ` +
          "and a board sample if one was taken."
      );
    }
    show(r.json); // copying refused both ways — select it by hand instead
  });

  onClick("exportNow", async () => {
    const r = await send({ type: "exportNow" });
    show(r ? r.text : NO_REPLY);
  });

  onClick("resetTiles", async () => {
    const r = await send({ type: "resetTiles" });
    show(r ? r.text : NO_REPLY);
  });

  for (const id of [...TEXT_FIELDS, ...NUM_FIELDS, "hud", "keepAwake", "recordTiles"]) {
    $(id).addEventListener("change", () => send({ type: "setConfig", config: readConfig() }));
  }

  api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab) return render(null);
    tabId = tab.id;
    if (!/^https:\/\/tronpick\.io\/gems\.php/.test(tab.url || "")) {
      api.storage.local.get(null, (saved) => fillConfig(saved || {}));
      return render(null);
    }
    refresh();
    poll = setInterval(refresh, 700);
  });

  window.addEventListener("unload", () => poll && clearInterval(poll));
})();
