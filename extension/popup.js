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
  let tabId = null;
  let connected = false;
  let poll = null;

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
    };
  }

  function fillConfig(cfg) {
    if (document.activeElement && document.activeElement.tagName === "INPUT") return;
    for (const f of TEXT_FIELDS) $(f).value = cfg[f] || "";
    for (const f of NUM_FIELDS) $(f).value = cfg[f] ? String(cfg[f]) : "";
    $("hud").checked = cfg.hud !== false;
    $("keepAwake").checked = cfg.keepAwake !== false;
  }

  function send(msg) {
    return new Promise((resolve) => {
      if (tabId === null) return resolve(null);
      try {
        api.tabs.sendMessage(tabId, msg, (resp) => {
          void api.runtime.lastError;
          resolve(resp || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function render(state) {
    if (!state) {
      connected = false;
      $("status").textContent =
        "Open https://tronpick.io/gems.php in this tab, then reopen this popup.";
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

    const t = $("toggle");
    t.textContent = state.running ? "Pause" : "Start";
    t.className = state.running ? "no" : "go";
    fillConfig(state.cfg || {});
  }

  async function refresh() {
    render(await send({ type: "getState" }));
  }

  $("toggle").addEventListener("click", async () => {
    if (!connected) return;
    const state = await send({ type: "getState" });
    if (state && state.running) {
      render(await send({ type: "stop" }));
    } else {
      render(await send({ type: "start", config: readConfig() }));
    }
  });

  $("reset").addEventListener("click", async () => render(await send({ type: "resetStats" })));

  $("diagnose").addEventListener("click", async () => {
    const info = await send({ type: "diagnose" });
    const out = $("out");
    out.classList.add("show");
    out.textContent = info
      ? JSON.stringify(info, null, 1)
      : "No response — the content script is not running on this tab.";
  });

  for (const id of [...TEXT_FIELDS, ...NUM_FIELDS, "hud", "keepAwake"]) {
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
