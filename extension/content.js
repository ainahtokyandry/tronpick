/* TronPick Gems Autoplay — content script
 *
 * Strategy (fixed):
 *   START -> middle tile of the bottom row (x1.46) -> if gem, CASHOUT -> repeat.
 *   A bomb ends the round and the next one starts automatically.
 *
 * The page markup is not known ahead of time, so every element is located by
 * what it looks like on screen (text content + geometry) rather than by class
 * names, which keeps this working if the site reskins.
 */
(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  if (!api || !api.runtime) return;
  if (window.__tpGemsBotLoaded) return;
  window.__tpGemsBotLoaded = true;

  // Claim the page via a DOM attribute, not just a JS global. If the extension
  // is installed twice (two builds of the app both enabled in Safari) each copy
  // gets its own isolated JS world but they share this document — without this
  // they would both run a play loop and click over each other.
  const CLAIM = "data-tp-gems-bot";
  if (document.documentElement.hasAttribute(CLAIM)) {
    console.warn("[Gems Autoplay] another instance already owns this page — standing down");
    // Standing down silently is worse than not running at all: this copy's
    // popup goes on sending messages to a listener that was never registered,
    // and Safari answers those with nothing whatsoever — no reply, no error, a
    // button that does nothing when pressed. With two copies installed the two
    // popups look identical, so there is no way to tell which one is dead.
    // Answering the message is what makes the duplicate visible.
    const notice =
      "Another copy of this extension owns this tab.\n" +
      "Two builds are installed. Turn one off in\n" +
      "Safari › Settings › Extensions, then reload\n" +
      "the page.";
    api.runtime.onMessage.addListener((_msg, _sender, sendResponse) => {
      sendResponse({ standDown: true, text: notice, json: "", rounds: 0 });
      return true;
    });
    return;
  }
  document.documentElement.setAttribute(CLAIM, "1");

  /* ---------------------------------------------------------------- config */

  const DEFAULTS = {
    running: false,
    betAmount: "0.02", // "" = leave whatever is typed on the page
    lowBalanceAt: 0, // below this balance, switch to lowBet (0 = off)
    lowBet: "", // the reduced bet to use below lowBalanceAt
    keepAwake: true, // hold a screen wake lock while running
    minBalance: 0, // stop when balance drops to/below this
    maxRounds: 0, // 0 = unlimited
    stopOnProfit: 0, // 0 = disabled, else stop once net >= this
    stopOnLoss: 0, // 0 = disabled, else stop once net <= -this
    clickDelay: 450, // pause between individual clicks
    settleDelay: 700, // pause after a tile reveals, before trusting the result
    roundDelay: 900, // pause between rounds
    hud: true,
  };

  // Tiles taken per round, counted from the bottom row up. Each row climbed
  // costs about 3% of the stake in expectation, so one row is the cheapest
  // round the game offers: -2.7% at x1.46 against -5.8% cashing out at x2.12.
  const PICKS = 1;
  const MAX_ERRORS = 8; // consecutive failed recoveries before really giving up

  let cfg = { ...DEFAULTS };

  // A blank bet means the default, not "leave whatever is on the page". Applied
  // wherever a config arrives rather than only at startup: the popup sends every
  // field together, so a form it has not filled in yet sends a blank bet, and
  // fixing that up only on load left the blank in place for the rest of the run.
  function normaliseCfg() {
    if (!String(cfg.betAmount || "").trim()) cfg.betAmount = DEFAULTS.betAmount;
  }
  let running = false;
  let loopToken = 0;
  let status = "Idle";
  let stopReason = "";
  let baseBet = ""; // the bet already on the page when you pressed Start
  let wakeLock = null;
  let roundOpen = false; // a round this loop already counted is still in play
  let pausedByNetwork = false; // stood down until the connection comes back
  // Whether the one reload has been spent. Kept in storage so it survives the
  // reload it describes — otherwise a page that comes back just as stuck would
  // reload itself for ever.
  let reloadTried = false;

  const stats = {
    rounds: 0,
    wins: 0,
    busts: 0,
    firstPickLosses: 0,
    secondPickLosses: 0,
    startBalance: null,
    balance: null,
  };

  const logLines = [];
  function log(msg) {
    const t = new Date().toLocaleTimeString();
    logLines.push(`[${t}] ${msg}`);
    if (logLines.length > 60) logLines.shift();
    renderHud();
  }

  /* --------------------------------------------------------------- helpers */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class Aborted extends Error {}

  function checkAbort(token) {
    if (!running || token !== loopToken) throw new Aborted("stopped");
  }

  function txt(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }

  const MULT_RE = /^x\s*\d+(?:[.,]\d+)?$/i;
  const BTN_RE = /^(start|cashout|cash\s*out)$/i;

  /* ------------------------------------------------------- element finding */

  // Every tile still showing its multiplier ("x1.46"). Tiles that have been
  // picked show an icon instead and simply drop out of this set — which is the
  // whole point: the row we are about to click always has all three intact, so
  // nothing here depends on being able to recognise a revealed tile.
  function multTiles() {
    const all = document.body.querySelectorAll("div,span,button,a,li,td,p");
    const hits = [];
    for (const el of all) {
      if (!MULT_RE.test(txt(el))) continue;
      if (!visible(el)) continue;
      hits.push(el);
    }
    // keep only the innermost matches (a wrapper div and its inner span both match)
    const leaves = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    return leaves.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        el,
        top: r.top,
        cx: r.left + r.width / 2,
        value: parseFloat(txt(el).replace(/[^\d.,]/g, "").replace(",", ".")),
      };
    });
  }

  // Unplayed rows grouped by vertical position, bottom-most first.
  // Row 0 is the x1.46 row, row 1 the x2.12 row, and so on.
  function boardRows() {
    const tiles = multTiles();
    const rows = [];
    for (const t of tiles) {
      let row = rows.find((x) => Math.abs(x.top - t.top) < 12);
      if (!row) {
        row = { top: t.top, tiles: [] };
        rows.push(row);
      }
      row.tiles.push(t);
    }
    for (const row of rows) {
      row.tiles.sort((a, b) => a.cx - b.cx);
      row.value = row.tiles[0].value;
    }
    rows.sort((a, b) => b.top - a.top); // bottom of the screen first
    return rows;
  }

  // Centre of the middle column, taken as the median across every full row, so a
  // row that has already lost a tile can still be aimed at correctly.
  function middleColumnX(rows) {
    const full = rows.filter((r) => r.tiles.length >= 3);
    const src = full.length ? full : rows;
    const mids = src
      .map((r) => r.tiles[Math.floor(r.tiles.length / 2)].cx)
      .sort((a, b) => a - b);
    return mids.length ? mids[Math.floor(mids.length / 2)] : null;
  }

  function middleTile(row, midX) {
    if (!row || !row.tiles.length) return null;
    if (midX === null) return row.tiles[Math.floor(row.tiles.length / 2)];
    return row.tiles.reduce((best, t) =>
      Math.abs(t.cx - midX) < Math.abs(best.cx - midX) ? t : best
    );
  }


  // The single big START / CASHOUT button.
  function findMainButton() {
    const all = document.body.querySelectorAll("button,a,div,span,input");
    const hits = [];
    for (const el of all) {
      const label = el.tagName === "INPUT" ? el.value || "" : txt(el);
      if (!BTN_RE.test(label.trim())) continue;
      if (!visible(el)) continue;
      hits.push(el);
    }
    const leaves = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    leaves.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return leaves[0] || null;
  }

  function buttonLabel() {
    const b = findMainButton();
    if (!b) return "";
    return (b.tagName === "INPUT" ? b.value || "" : txt(b)).trim().toLowerCase();
  }

  // "idle" = START showing (no round in progress); "active" = CASHOUT showing.
  function gameState() {
    const label = buttonLabel();
    if (!label) return "unknown";
    return label === "start" ? "idle" : "active";
  }

  // Words the page puts on or around a field, for telling one number box from
  // another: its own attributes, its label, and the text of the block it sits
  // in — which is where "Bet Amount" lives.
  function fieldWords(el) {
    const bits = [
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("placeholder"),
      el.getAttribute("class"),
    ];
    if (el.id) {
      try {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) bits.push(txt(l));
      } catch (_) {}
    }
    let p = el.parentElement;
    for (let i = 0; p && i < 3; i++, p = p.parentElement) bits.push(txt(p).slice(0, 80));
    return bits.filter(Boolean).join(" ").toLowerCase();
  }

  // The box the stake is typed into — not the one beside it showing what that
  // stake would return. Taking the first number on the page found the payout,
  // which holds bet × the row multiplier: the panel read 0.029200 against a bet
  // of 0.020000, and every bet the loop tried to set was written into a box the
  // site recalculates and ignores. So the stake never changed, whatever it was
  // asked for. A field the page will not let you type in cannot be the bet, and
  // one the page labels as the bet is.
  // Ranked rather than filtered. Being typeable is only a hint: the site
  // disables the bet box while a round is open, so refusing a disabled field
  // outright made the bet unreadable for most of every round — it fell through
  // to some other box holding a nought.
  function findBetInput() {
    const numeric = [...document.body.querySelectorAll("input")].filter(
      (i) => visible(i) && /^\d*\.?\d+$/.test((i.value || "").trim())
    );
    const score = (i) =>
      (/bet|stake|wager/.test(fieldWords(i)) ? 4 : 0) +
      (i.readOnly ? 0 : 2) +
      (/^\d*\.\d+$/.test((i.value || "").trim()) ? 1 : 0);
    let best = null;
    for (const i of numeric) {
      if (!best || score(i) > score(best)) best = i;
    }
    return best;
  }

  function betInputValue() {
    const el = findBetInput();
    return el ? (el.value || "").trim() : "";
  }

  function currentBet() {
    const v = parseFloat(betInputValue());
    return Number.isFinite(v) ? v : null;
  }

  function setBet(value) {
    const el = findBetInput();
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    ).set;
    setter.call(el, value);
    for (const type of ["input", "change", "keyup", "blur"]) {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    }
    return true;
  }

  // Text belonging directly to this element, ignoring text inside its children.
  // The header balance sits next to a currency icon, so the number lives in a
  // container that also has an <img> child — matching on textContent alone made
  // that element look non-leaf and the search fell through to the bet field.
  function ownText(el) {
    let s = "";
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue;
    return s.replace(/\s+/g, " ").trim();
  }

  // Wallet balance — the top-most standalone decimal number on screen.
  //
  // An <option> counts only when it is the selected one, and only when nothing
  // visible was found. The currency picker beside the balance carries an option
  // per coin, each with a number of its own, and an unselected one is another
  // wallet entirely: reading one of those showed 0.009200 against a real balance
  // of 11.298588 and stopped the session for running out of funds it had plenty
  // of. Options have no geometry to sort by either, so the first in the document
  // won — which is not even the coin being played.
  // Every standalone decimal on screen, nearest the top of the page first. The
  // balance is not always plain text — a header that shows it beside a currency
  // chooser may hold it in a <select> or an <input>, neither of which has text
  // for ownText to find, and missing it that way left the top-most number on
  // screen being something else entirely.
  function balanceCandidates() {
    const out = [];
    // Every element, not a list of tags. Twice now the header holding the
    // balance has turned out not to be among the tags being asked for — a
    // button, a heading, something wrapping it — and the search quietly settled
    // on the next number down the page instead. Walking everything costs a few
    // milliseconds at a round boundary and cannot miss.
    for (const el of document.body.querySelectorAll("*")) {
      let t;
      if (el.tagName === "SELECT") {
        const o = el.selectedOptions && el.selectedOptions[0];
        t = o ? (o.textContent || "").replace(/\s+/g, " ").trim() : "";
      } else if (el.tagName === "INPUT") {
        // Only a box you cannot type in. An editable one is a control — the bet
        // field, or the empty box beside it that reads 0.000000 between rounds
        // and was taken for a wallet with nothing left in it.
        if (!el.readOnly && !el.disabled) continue;
        t = (el.value || "").trim();
      } else {
        t = ownText(el);
      }
      if (!/^\d+\.\d{2,10}$/.test(t)) continue;
      if (!visible(el)) continue;
      const top = el.getBoundingClientRect().top;
      // On screen, not merely in the document. `visible` asks about size and
      // CSS, which an element scrolled off the top of the page passes happily:
      // one sitting at -296px sorted above everything and was read as the
      // wallet, which is how a balance of 11.3 came back as 0.
      if (top < 0 || top > (window.innerHeight || 0)) continue;
      out.push({ el, top, value: parseFloat(t) });
    }
    // Nearest the top of the page, but a box the page itself calls a balance
    // wins over one that merely sits high up. Only a preference: if the site
    // renames it, this falls back to position, which is how it worked before.
    const named = (b) =>
      /bal|wallet|funds/i.test(
        `${b.el.getAttribute("class") || ""} ${b.el.getAttribute("id") || ""}`
      );
    out.sort((a, b) => named(b) - named(a) || a.top - b.top);
    return out;
  }

  function balanceElement() {
    const seen = balanceCandidates();
    if (seen.length) return seen[0];
    // Nothing on screen: a hidden <select> still knows which coin is selected.
    for (const o of document.body.querySelectorAll("option")) {
      const t = ownText(o);
      if (o.selected && /^\d+\.\d{2,10}$/.test(t)) {
        return { el: o, top: -1, value: parseFloat(t) };
      }
    }
    return null;
  }

  function findBalance() {
    const found = balanceElement();
    return found ? found.value : null;
  }

  /* --------------------------------------------------------------- clicking */

  function realClick(el) {
    if (!el) return false;
    // Only scroll when the tile is actually off-screen — re-centring on every
    // click makes the page jump around and fights the site's own scrolling.
    let r = el.getBoundingClientRect();
    if (r.top < 8 || r.bottom > (window.innerHeight || 0) - 8) {
      el.scrollIntoView({ block: "center", behavior: "instant" });
      r = el.getBoundingClientRect();
    }
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      detail: 1,
    };
    const p = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
    try {
      el.dispatchEvent(new PointerEvent("pointerover", { ...p, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseover", { ...base, buttons: 0 }));
      el.dispatchEvent(new PointerEvent("pointerdown", { ...p, buttons: 1 }));
      el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...p, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
    } catch (e) {
      try {
        el.click();
      } catch (_) {
        return false;
      }
    }
    return true;
  }

  async function waitFor(token, predicate, timeout, interval = 120) {
    const t0 = Date.now();
    for (;;) {
      checkAbort(token);
      const v = predicate();
      if (v) return v;
      if (Date.now() - t0 >= timeout) return null;
      await sleep(interval);
    }
  }

  /* ------------------------------------------------------------ round logic */

  // Where the game actually is, read fresh from the page rather than from
  // whatever this loop last believed. Everything resumable is derived here.
  //
  // Rows come back bottom-first and a row we have already picked from is short
  // a tile, so counting short rows up from the bottom gives the number of picks
  // that landed — regardless of whether this loop is the one that made them, or
  // whether it ever saw them land.
  function readBoard() {
    const rows = boardRows();
    const state = gameState();
    const width = rows.reduce((n, r) => Math.max(n, r.tiles.length), 0);
    let picked = 0;
    for (const r of rows) {
      if (r.tiles.length >= width) break;
      picked++;
    }
    return { state, rows, width, picked, open: state === "active" };
  }

  // Click one tile and wait to learn whether it was a gem or a bomb.
  async function pickTile(token, rowIndex) {
    const rows = boardRows();
    const row = rows[rowIndex];
    if (!row) {
      throw new Error(
        `row ${rowIndex + 1} not found (board shows ${rows.length} unplayed rows)`
      );
    }
    const target = middleTile(row, middleColumnX(rows));
    if (!target) throw new Error(`middle tile of row ${rowIndex + 1} not found`);

    const label = Number.isFinite(row.value) ? `x${row.value}` : `row ${rowIndex + 1}`;
    const totalBefore = rows.reduce((n, r) => n + r.tiles.length, 0);
    setStatus(`Picking middle tile of ${label}`);
    log(`Pick ${rowIndex + 1} → middle of ${label}`);

    realClick(target.el);
    let lastClick = Date.now();
    let attempts = 1;
    const deadline = Date.now() + 15000;
    let lastTotal = totalBefore;
    let changedAt = 0;

    for (;;) {
      checkAbort(token);

      // Round over -> the button flipped back to START, i.e. we hit a bomb.
      if (gameState() === "idle") return "bomb";

      const total = multTiles().length;
      // Whole board revealed -> no multipliers left anywhere, also a bomb.
      if (total === 0) return "bomb";
      if (total !== lastTotal) {
        lastTotal = total;
        changedAt = Date.now();
      }

      if (total < totalBefore) {
        // Something was revealed — but a bomb reveals the *entire* board, and it
        // does not do so in a single repaint. Deciding the moment the first tile
        // flips reads a bomb as a gem, so wait until the board stops changing
        // and then judge by how much of it went.
        if (Date.now() - changedAt >= cfg.settleDelay) {
          if (gameState() === "idle") return "bomb";
          // exactly our tile went -> gem; anything more -> the board is opening up
          return total === totalBefore - 1 ? "gem" : "bomb";
        }
      } else if (Date.now() - lastClick > 2500 && attempts < 3) {
        // Nothing moved at all. The board may still have been animating the
        // previous step, so re-click rather than sitting out the timeout.
        attempts++;
        log(`No response on ${label} — re-clicking (attempt ${attempts})`);
        realClick(target.el);
        lastClick = Date.now();
      }

      if (Date.now() > deadline) {
        throw new Error(
          `${label} did not respond to ${attempts} click(s) — ` +
            `${total}/${totalBefore} tiles still unplayed`
        );
      }
      await sleep(120);
    }
  }

  async function playRound(token) {
    const board = readBoard();

    // A round is already open — this loop timed out mid-round, the page was
    // reloaded, or you opened one by hand. Pick it up where the board says it
    // got to instead of throwing away a live stake.
    if (board.open) {
      if (!roundOpen) {
        stats.rounds++;
        roundOpen = true;
        log(`Adopting an open round as round ${stats.rounds}`);
      }
      const from = Math.min(board.picked, PICKS);
      log(
        `Resuming round ${stats.rounds} — ${board.picked} tile(s) already picked` +
          (from >= PICKS ? ", cashing out" : `, next is pick ${from + 1}`)
      );
      setStatus("Resuming an open round");
      return finishRound(token, from);
    }

    if (board.state !== "idle") throw new Error("START button not found on the page");

    // Choose this round's stake before betting: below the low-balance mark the
    // reduced bet is used, and it goes back up if the balance recovers.
    const balance = findBalance();
    let want = String(cfg.betAmount || baseBet || "").trim();
    const lowBet = String(cfg.lowBet || "").trim();
    if (lowBet && cfg.lowBalanceAt > 0 && balance !== null && balance < cfg.lowBalanceAt) {
      if (want !== lowBet) {
        log(`Balance ${balance} is under ${cfg.lowBalanceAt} — betting ${lowBet}`);
      }
      want = lowBet;
    }
    if (want) {
      const have = currentBet();
      if (have === null || Math.abs(have - parseFloat(want)) > 1e-9) {
        if (setBet(want)) log(`Bet set to ${want}`);
        await sleep(250);
      }
    }

    const bet = currentBet();
    if (balance !== null) {
      stats.balance = balance;
      if (!stats.startBalance) stats.startBalance = balance;
      if (cfg.minBalance > 0 && balance <= cfg.minBalance) {
        return stop(`Balance ${balance} reached your floor of ${cfg.minBalance}`);
      }
      // Out of funds ends the session, so it is worth being sure. Reading the
      // wrong number off the page has ended two already — a figure from the
      // bets table below, a coin that was not the one being played — and one
      // bad read should not be able to do that. Look again, a moment later,
      // and only believe it if the page still says so.
      if (bet !== null && balance < bet) {
        await sleep(600);
        const again = findBalance();
        if (again !== null && again < bet) {
          const from = balanceElement();
          return stop(
            `Balance ${again} is below the bet of ${bet} — out of funds ` +
              `(read from <${from ? from.el.tagName.toLowerCase() : "?"}>)`
          );
        }
        log(`Balance read as ${balance}, then ${again} — ignoring the first`);
        if (again !== null) stats.balance = again;
      }
    }

    setStatus("Starting round");
    realClick(findMainButton());

    const started = await waitFor(
      token,
      () => gameState() === "active" && boardRows().length >= 2,
      8000
    );
    if (!started) {
      throw new Error(
        "START did not open a round (out of funds, or the site is showing a dialog)"
      );
    }
    stats.rounds++;
    roundOpen = true;
    const ladder = boardRows()
      .slice(0, 3)
      .map((r) => `x${r.value}(${r.tiles.length})`)
      .join(" ");
    log(`Round ${stats.rounds} open — bottom rows: ${ladder}`);
    await sleep(cfg.clickDelay);

    return finishRound(token, 0);
  }

  // Climb the ladder from pick `from` upward, then cash out. Taking the
  // starting index as an argument is what makes a round resumable: after a
  // timeout the board is re-read and this is re-entered at the right step
  // rather than from the bottom, which would re-click an already-picked tile.
  async function finishRound(token, from) {
    for (let i = from; i < PICKS; i++) {
      const result = await pickTile(token, i);
      if (result === "bomb") {
        stats.busts++;
        if (i === 0) stats.firstPickLosses++;
        else stats.secondPickLosses++;
        roundOpen = false;
        log(`Round ${stats.rounds}: bomb on pick ${i + 1}`);
        return "bust";
      }
      log(`Round ${stats.rounds}: gem on pick ${i + 1}`);
      await sleep(cfg.clickDelay);
    }

    setStatus("Cashing out");
    realClick(findMainButton());
    const done = await waitFor(token, () => gameState() === "idle", 10000);
    if (!done) throw new Error("cashout did not complete");
    roundOpen = false;
    stats.wins++;
    return "win";
  }

  /* ----------------------------------------------------------------- driver */

  async function mainLoop(token) {
    let errors = 0;
    while (running && token === loopToken) {
      try {
        const result = await playRound(token);
        if (!running) break;
        errors = 0;
        // A round got through, so the page is working: give the next wedge its
        // own reload rather than holding this one spent for the whole session.
        if (reloadTried) {
          reloadTried = false;
          persist();
        }

        const balance = findBalance();
        if (balance !== null) stats.balance = balance;
        const net =
          stats.balance !== null && stats.startBalance !== null
            ? stats.balance - stats.startBalance
            : null;

        if (result === "win" || result === "bust") {
          log(
            `Round ${stats.rounds} ${result === "win" ? "WON" : "LOST"} · ` +
              `W:${stats.wins} L:${stats.busts}` +
              (net !== null ? ` · net ${net >= 0 ? "+" : ""}${net.toFixed(6)}` : "")
          );
        }
        saveStats();

        if (cfg.maxRounds > 0 && stats.rounds >= cfg.maxRounds) {
          return stop(`Reached ${cfg.maxRounds} rounds`);
        }
        if (net !== null && cfg.stopOnProfit > 0 && net >= cfg.stopOnProfit) {
          return stop(`Take-profit hit (+${net.toFixed(6)})`);
        }
        if (net !== null && cfg.stopOnLoss > 0 && net <= -cfg.stopOnLoss) {
          return stop(`Stop-loss hit (${net.toFixed(6)})`);
        }
        if (cfg.minBalance > 0 && stats.balance !== null && stats.balance <= cfg.minBalance) {
          return stop(`Balance floor reached (${stats.balance})`);
        }

        setStatus("Waiting for next round");
        await sleep(cfg.roundDelay);
      } catch (err) {
        if (err instanceof Aborted) return;
        errors++;
        log(`Hiccup (${errors}/${MAX_ERRORS}): ${err.message}`);
        if (errors >= MAX_ERRORS) {
          // Eight failures in a row is usually the page rather than the loop —
          // a dialog we cannot see, a socket that died, a board that never
          // finished animating. Re-reading cannot fix any of those; a reload
          // can. `running` stays set in storage, so the loop starts itself
          // again on the way back and adopts whatever round it finds open.
          if (!reloadTried) {
            reloadTried = true;
            persist();
            saveStats();
            log(`Stuck after ${errors} recoveries — reloading the page once`);
            setStatus("Reloading the page");
            setTimeout(() => location.reload(), 400);
            return;
          }
          return stop(
            `Gave up after ${errors} failed recoveries and a reload — ${err.message}`
          );
        }
        // Back off, then go round again. playRound re-reads the page, so it
        // resumes an open round rather than starting over — a failure is a
        // pause, not the end of the session. Only a run of them stops us.
        setStatus(`Recovering (${errors}/${MAX_ERRORS})`);
        saveStats();
        await sleep(Math.min(1500 * errors, 8000));
      }
    }
  }

  function setStatus(s) {
    status = s;
    renderHud();
  }

  /* ------------------------------------------------------------- wake lock */

  // Holds the display awake while the bot runs. Safari only grants this to a
  // visible document and drops it whenever the tab is hidden, so it is
  // re-acquired when the tab comes back to the front.
  async function acquireWakeLock() {
    if (!cfg.keepAwake || wakeLock) return;
    if (!("wakeLock" in navigator)) {
      log("Screen wake lock is not available in this Safari — use `caffeinate -dimsu`");
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
      log("Holding the display awake");
    } catch (e) {
      wakeLock = null;
      log(`Could not hold the display awake: ${e.message}`);
    }
  }

  function releaseWakeLock() {
    if (!wakeLock) return;
    try {
      wakeLock.release();
    } catch (_) {}
    wakeLock = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (running && cfg.keepAwake && document.visibilityState === "visible") {
      acquireWakeLock();
    }
  });

  function start() {
    if (running) return;
    // Pressing Start with no connection arms it rather than refusing: the round
    // could not be played now, and this is the same waiting the loop would be
    // doing anyway.
    if (!navigator.onLine) {
      pausedByNetwork = true;
      stopReason = "Waiting for the network";
      setStatus("Waiting for the network");
      log("No network — will start when it comes back");
      persist();
      return;
    }
    pausedByNetwork = false;
    running = true;
    stopReason = "";
    const token = ++loopToken;
    // Only take the baseline the first time, so pausing and resuming continues
    // the same session instead of zeroing Net. "Reset stats" re-baselines.
    const bal = findBalance();
    if (bal !== null) {
      stats.balance = bal;
      if (!stats.startBalance) stats.startBalance = bal;
    }
    const onPage = betInputValue();
    if (onPage) baseBet = onPage;
    acquireWakeLock();
    log(`Autoplay started (bet ${cfg.betAmount || baseBet || "as-is"})`);
    setStatus("Running");
    persist();
    mainLoop(token);
  }

  function stop(reason) {
    if (!running && !reason) return;
    running = false;
    loopToken++;
    // Stopping cancels an armed resume. Pressing Pause, hitting a stop-loss or
    // running out of funds all mean this session is over; coming back online is
    // not a reason to overrule any of them. Only the network handler below
    // re-arms it, and it does so after this has run.
    pausedByNetwork = false;
    releaseWakeLock();
    stopReason = reason || "Paused";
    log(`Stopped — ${stopReason}`);
    setStatus(`Stopped: ${stopReason}`);
    persist();
    saveStats();
  }

  /* -------------------------------------------------------------- network */

  /* Losing the connection mid-session is worse than it looks: clicks land on a
   * page that cannot answer, the loop spends its eight recoveries finding that
   * out, and a round with a live stake in it can be left open while that plays
   * out. Standing down the moment the machine goes offline, and picking up again
   * when it comes back, costs a few lines. An open round is not abandoned by
   * this — the loop reads the board on resuming and carries on from whatever it
   * finds, exactly as it does after a reload.
   *
   * `navigator.onLine` only says the machine has a network interface up. Wi-Fi
   * attached to a router with no internet behind it still reads as online, and
   * nothing here will notice; what catches that is the game failing to respond,
   * which the recovery already handles.
   */

  function offline() {
    if (!running) return;
    stop("The network went away");
    pausedByNetwork = true; // after stop(), which clears it
    persist();
  }

  function online() {
    if (!pausedByNetwork || running) return;
    pausedByNetwork = false;
    persist();
    log("Network is back — resuming");
    // A moment for the page to be worth talking to again. Whatever state the
    // board was left in, playRound reads it fresh.
    setTimeout(() => {
      if (!running && navigator.onLine && gameState() !== "unknown") start();
    }, 2500);
  }

  window.addEventListener("offline", offline);
  window.addEventListener("online", online);

  function persist() {
    try {
      api.storage.local.set({ ...cfg, running, pausedByNetwork, reloadTried });
    } catch (_) {}
  }

  // Counters live in extension storage rather than memory, so a page reload or
  // a Safari restart continues the same tally instead of starting over. Only
  // "Reset stats" clears it. Written at round boundaries, not on every poll.
  function saveStats() {
    try {
      api.storage.local.set({ stats: { ...stats }, log: logLines.slice(-40) });
    } catch (_) {}
  }

  function snapshot() {
    const net =
      stats.balance !== null && stats.startBalance !== null
        ? stats.balance - stats.startBalance
        : null;
    return {
      running,
      status,
      stopReason,
      stats: { ...stats, net },
      cfg,
      log: logLines.slice(-25),
      detected: {
        button: buttonLabel() || "(not found)",
        rows: boardRows().length,
        bet: currentBet(),
        balance: findBalance(),
      },
    };
  }

  /* -------------------------------------------------------------------- HUD */

  let hudHost = null;
  let hudRoot = null;

  function buildHud() {
    if (hudHost) return;
    hudHost = document.createElement("div");
    hudHost.id = "tp-gems-bot-hud";
    hudHost.style.cssText =
      "position:fixed;right:14px;bottom:14px;z-index:2147483647;display:block;";
    hudRoot = hudHost.attachShadow({ mode: "open" });
    hudRoot.innerHTML = `
      <style>
        :host { display: block; }
        .panel {
          font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
          width: 250px; background: #1f2a35; color: #e8eef4;
          border: 1px solid #35485c; border-radius: 10px;
          box-shadow: 0 6px 24px rgba(0,0,0,.35); overflow: hidden;
        }
        .hd { display:flex; align-items:center; gap:8px; padding:9px 11px;
              background:#182129; border-bottom:1px solid #35485c; }
        .dot { width:9px; height:9px; border-radius:50%; background:#6b7a89; flex:none; }
        .dot.on { background:#49c96d; box-shadow:0 0 7px #49c96d; }
        .ttl { font-weight:600; font-size:12px; flex:1; }
        .body { padding: 9px 11px; }
        .st { color:#9fb3c6; margin-bottom:7px; min-height:16px; }
        .grid { display:grid; grid-template-columns:1fr 1fr; gap:3px 10px; margin-bottom:9px; }
        .k { color:#8fa3b5; } .v { text-align:right; font-variant-numeric:tabular-nums; }
        .pos { color:#5fd18a; } .neg { color:#ef7d7d; }
        .btns { display:flex; gap:6px; }
        button { flex:1; font:600 12px/1 inherit; padding:7px 0; border-radius:6px;
                 border:0; cursor:pointer; color:#fff; }
        .go { background:#3fa2e8; } .go:hover { background:#57b0ec; }
        .no { background:#d9534f; } .no:hover { background:#e0625e; }
        .mini { background:#3a4b5c; flex:0 0 34px; }
        .logs { margin-top:8px; max-height:96px; overflow:auto; font-size:10.5px;
                color:#88a0b5; border-top:1px solid #2c3b4a; padding-top:6px;
                display:none; white-space:pre-wrap; }
        .logs.show { display:block; }
      </style>
      <div class="panel">
        <div class="hd"><span class="dot"></span><span class="ttl">Gems Autoplay</span></div>
        <div class="body">
          <div class="st"></div>
          <div class="grid">
            <span class="k">Rounds</span><span class="v" data-k="rounds">0</span>
            <span class="k">Won / Lost</span><span class="v" data-k="wl">0 / 0</span>
            <span class="k">Bet</span><span class="v" data-k="bet">–</span>
            <span class="k">Balance</span><span class="v" data-k="bal">–</span>
            <span class="k">Net</span><span class="v" data-k="net">–</span>
          </div>
          <div class="btns">
            <button class="go" data-a="toggle">Start</button>
            <button class="mini" data-a="logs" title="Show log">☰</button>
          </div>
          <div class="logs"></div>
        </div>
      </div>`;
    hudRoot.addEventListener("click", (e) => {
      const a = e.target.getAttribute && e.target.getAttribute("data-a");
      if (a === "toggle") (running ? stop("Paused from the page") : start());
      if (a === "logs") hudRoot.querySelector(".logs").classList.toggle("show");
    });
    (document.body || document.documentElement).appendChild(hudHost);
  }

  function renderHud() {
    if (!cfg.hud) {
      if (hudHost) hudHost.style.display = "none";
      return;
    }
    buildHud();
    hudHost.style.display = "";
    const q = (s) => hudRoot.querySelector(s);
    q(".dot").classList.toggle("on", running);
    q(".st").textContent = status;
    q('[data-k="rounds"]').textContent = String(stats.rounds);
    q('[data-k="wl"]').textContent = `${stats.wins} / ${stats.busts}`;
    q('[data-k="bet"]').textContent = betInputValue() || "–";
    q('[data-k="bal"]').textContent =
      stats.balance === null ? "–" : stats.balance.toFixed(6);
    const netEl = q('[data-k="net"]');
    const net =
      stats.balance !== null && stats.startBalance !== null
        ? stats.balance - stats.startBalance
        : null;
    netEl.textContent = net === null ? "–" : (net >= 0 ? "+" : "") + net.toFixed(6);
    netEl.className = "v " + (net === null ? "" : net >= 0 ? "pos" : "neg");
    const btn = q('[data-a="toggle"]');
    btn.textContent = running ? "Pause" : "Start";
    btn.className = running ? "no" : "go";
    const logs = q(".logs");
    if (logs.classList.contains("show")) {
      logs.textContent = logLines.slice(-25).join("\n");
      logs.scrollTop = logs.scrollHeight;
    }
  }

  /* --------------------------------------------------------------- messages */

  // Every branch below answers synchronously, but the listener returns true to
  // hold the channel open, so a throw on the way to sendResponse would leave the
  // popup waiting for a reply that never comes — a button that silently does
  // nothing. The error is sent back instead, in whatever shape the caller reads.
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      handleMessage(msg, sendResponse);
    } catch (err) {
      const text = `The content script threw on "${msg && msg.type}": ${err.message}`;
      log(text);
      sendResponse({ error: text, text, json: "", rounds: 0 });
    }
    return true;
  });

  function handleMessage(msg, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === "getState") {
      sendResponse(snapshot());
    } else if (msg.type === "setConfig") {
      cfg = { ...cfg, ...msg.config };
      normaliseCfg();
      persist();
      renderHud();
      sendResponse(snapshot());
    } else if (msg.type === "start") {
      if (msg.config) cfg = { ...cfg, ...msg.config };
      normaliseCfg();
      start();
      sendResponse(snapshot());
    } else if (msg.type === "stop") {
      stop("Paused");
      sendResponse(snapshot());
    } else if (msg.type === "resetStats") {
      Object.assign(stats, {
        rounds: 0,
        wins: 0,
        busts: 0,
        firstPickLosses: 0,
        secondPickLosses: 0,
        // A baseline of zero is not a baseline: it made Net read as the whole
        // balance. When the page cannot be read, leave it unset and let the
        // first good reading take it.
        startBalance: findBalance() || null,
      });
      stats.balance = stats.startBalance;
      logLines.length = 0;
      saveStats();
      renderHud();
      sendResponse(snapshot());
    } else if (msg.type === "diagnose") {
      const all = boardRows();
      const midX = middleColumnX(all);
      const rows = all.map((r, i) => ({
        row: i,
        value: r.value,
        tiles: r.tiles.map((t) => txt(t.el)),
        middle: txt(middleTile(r, midX).el),
      }));
      const board = readBoard();
      sendResponse({
        button: buttonLabel() || "(not found)",
        state: gameState(),
        roundOpen: board.open,
        tilesAlreadyPicked: board.picked,
        wouldResumeAt: board.open ? Math.min(board.picked, PICKS) + 1 : "new round",
        rowsFound: rows.length,
        middleColumnX: midX === null ? null : Math.round(midX),
        rows: rows.slice(0, 4),
        bet: currentBet(),
        // Which box on the page that number came from, since picking the wrong
        // one is silent: the bet simply never changes.
        betField: (() => {
          const el = findBetInput();
          if (!el) return "(not found)";
          return `<input ${el.getAttribute("name") || el.getAttribute("id") || "?"}> = ${
            (el.value || "").trim()
          } · near "${fieldWords(el).slice(0, 50)}"`;
        })(),
        wantsBet: cfg.betAmount,
        balance: findBalance(),
        // Where that number came from. Reading the wrong one stops the session
        // for running out of funds that were never missing.
        // Every number it could have taken, nearest the top first, so a wrong
        // pick can be seen rather than deduced.
        balanceCandidates: balanceCandidates()
          .slice(0, 6)
          .map(
            (b) =>
              `${Math.round(b.top)}px <${b.el.tagName.toLowerCase()}` +
              `${b.el.getAttribute("class") ? ` class="${b.el.getAttribute("class").slice(0, 30)}"` : ""}> = ${b.value}`
          ),
      });
    }
  }

  /* ----------------------------------------------------------------- bootstrap */

  api.storage.local.get(null, (stored) => {
    const saved = stored || {};
    // cfg takes only the keys it owns, so the stats/log entries stored
    // alongside it do not leak into the config object.
    cfg = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (saved[k] !== undefined) cfg[k] = saved[k];
    }
    normaliseCfg();

    // Carry the previous tally forward — Net is only zeroed by "Reset stats".
    if (saved.stats) {
      for (const k of Object.keys(stats)) {
        if (saved.stats[k] !== undefined) stats[k] = saved.stats[k];
      }
      // A stored baseline of zero came from a reading that failed, and it makes
      // Net the whole balance. Drop it and let the next good reading stand in.
      if (!stats.startBalance) stats.startBalance = null;
    }
    if (Array.isArray(saved.log)) logLines.push(...saved.log.slice(-40));
    // Keep the restored baseline but show the balance as it is right now.
    const bal = findBalance();
    if (bal !== null) stats.balance = bal;

    // A session paused because the network went is still a session waiting to
    // run: a reload in the meantime must not quietly turn it into a stopped one.
    pausedByNetwork = !!saved.pausedByNetwork;
    reloadTried = !!saved.reloadTried;
    const wasRunning = !!saved.running || pausedByNetwork;
    cfg.running = false;
    renderHud();
    if (wasRunning) {
      // resume after a page reload
      setTimeout(() => {
        if (gameState() !== "unknown") start();
      }, 1500);
    }
  });

  window.addEventListener("beforeunload", () => {
    // keep `running` in storage so a reload resumes, but halt the loop cleanly
    loopToken++;
  });
})();
