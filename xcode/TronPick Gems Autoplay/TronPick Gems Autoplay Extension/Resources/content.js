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
    recordTiles: true, // log every revealed board and test it for column bias
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
  let roundGrid = null; // this round's cells, captured while they are still findable

  // Every finished round, described in full: how it ended, which tiles we took,
  // and what each cell of the board was showing. A cell holds the signature
  // itself rather than an index into a table of them, so a round stands on its
  // own — which is what lets the collector work out what the pictures mean over
  // the whole history, and change its mind later without anything here needing
  // to be rewritten.
  const history = [];
  const HISTORY_MAX = 3000; // kept in the browser; the collector keeps the rest
  const TILE_ROWS_MAX = 12; // rows read per round, counting up from the bottom
  const EXPORT_EVERY = 50; // rounds to gather before sending a batch

  // Rounds are numbered within a run of the page and the run is named, so the
  // collector can tell a batch it has already filed from a new one however many
  // times a flush is retried.
  const session = Math.random().toString(36).slice(2, 10);
  let seq = 0;
  let unsent = 0; // records at the end of `history` not yet acknowledged
  let flushing = false;
  let collector = null; // what the collector last said, or why it could not be reached

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

  // Wallet balance — the top-most standalone decimal number on the page.
  function findBalance() {
    let best = null;
    for (const el of document.body.querySelectorAll(
      "span,div,b,strong,a,li,option,td,p,h1,h2,h3,label"
    )) {
      const t = ownText(el);
      if (!/^\d+\.\d{2,10}$/.test(t)) continue;
      const isOption = el.tagName === "OPTION";
      if (!isOption && !visible(el)) continue;
      // an <option> has no useful geometry; treat it as top-of-page
      const top = isOption ? -1 : el.getBoundingClientRect().top;
      if (!best || top < best.top) best = { top, value: parseFloat(t) };
    }
    return best ? best.value : null;
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

  /* -------------------------------------------------------- board recorder */

  /* The question this answers: is the bomb equally likely in every column, and
   * does the column we keep clicking behave like the ones we never touch?
   *
   * A revealed tile no longer says anything we could search the page for, so the
   * grid is captured while the multipliers are still on screen and read back
   * afterwards through the element references taken at that moment. Nothing here
   * needs to know which icon is a gem and which is a bomb: the tiles we picked
   * ourselves have a known outcome, and that is what teaches it the difference.
   */

  // Last path segment of a src or url(...), which is the stable part of an icon
  // reference — the rest is directory noise and cache-busting query strings.
  function tail(v) {
    const s = String(v || "")
      .replace(/^url\(\s*["']?/, "")
      .replace(/["']?\s*\)$/, "")
      .split("?")[0]
      .split("#")[0];
    return s.slice(s.lastIndexOf("/") + 1).slice(0, 40);
  }

  // Showing nothing is itself a way of looking. On this board a gem is an icon
  // element and a bomb is an empty span — the losing tile has no picture at all —
  // so a revealed tile with nothing in it has to be a description in its own
  // right rather than a failure to read one. Without this every bomb ever
  // revealed came back indistinguishable from a tile that could not be found.
  const BLANK_SIG = "(blank)";

  // What a tile is showing, described only by the picture inside it. The tile's
  // own background and classes are skipped on purpose: the one we clicked is
  // highlighted, and that must not make its icon look different from its
  // neighbours' — the whole classification rests on identical icons matching.
  // It is also what makes the blank above work: our own bomb and an untouched
  // one both come back blank, where reading the tile's classes would have made
  // the one we clicked unique.
  function tileSig(el) {
    if (!el || !el.isConnected) return "";
    const t = txt(el);
    if (MULT_RE.test(t)) return ""; // still face down
    const icons = [];
    const classes = [];
    for (const n of [el, ...el.querySelectorAll("*")]) {
      const tag = n.tagName.toLowerCase();
      if (tag === "img") icons.push("img:" + tail(n.getAttribute("src")));
      else if (tag === "use")
        icons.push("use:" + tail(n.getAttribute("href") || n.getAttribute("xlink:href")));
      else if (tag === "path")
        icons.push("d:" + (n.getAttribute("d") || "").replace(/\s+/g, "").slice(0, 24));
      else if (tag === "svg" && n.getAttribute("viewBox"))
        icons.push("vb:" + n.getAttribute("viewBox"));
      // Only leaves are probed for a drawn-on icon: a wrapper's background is
      // decoration, and reading computed styles is the slow part of this walk.
      if (n === el || n.children.length) continue;
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== "none")
        icons.push("bg:" + tail(cs.backgroundImage));
      for (const pseudo of ["::before", "::after"]) {
        const c = getComputedStyle(n, pseudo).content;
        if (c && !/^(none|normal|"\s*"|'\s*')$/.test(c)) icons.push("c:" + c.slice(0, 24));
      }
      if (!ownText(n)) for (const c of n.classList) classes.push("cls:" + c);
    }
    const parts = icons.length ? icons : classes.length ? classes : t ? ["txt:" + t.slice(0, 16)] : [];
    // On screen, holding no text and no picture: a bomb. Anything not on screen
    // stays unread — an element we cannot see is not evidence of anything.
    if (!parts.length) return visible(el) ? BLANK_SIG : "";
    // sorted and de-duplicated so the same picture always yields the same string
    return [...new Set(parts)].sort().join("|").slice(0, 200);
  }

  // One x per column, taken across every full row, so a row that has already
  // lost a tile still lines up with the grid.
  function columnCenters(rows, width) {
    const full = rows.filter((r) => r.tiles.length === width);
    const src = full.length ? full : rows;
    const out = [];
    for (let c = 0; c < width; c++) {
      const xs = src
        .map((r) => r.tiles[c])
        .filter(Boolean)
        .map((t) => t.cx)
        .sort((a, b) => a - b);
      if (!xs.length) return [];
      out.push(xs[Math.floor(xs.length / 2)]);
    }
    return out;
  }

  // The element that *is* the tile: the outermost box around a multiplier that
  // does not also contain another one. Holding that reference is what lets a
  // tile be read after its text has been swapped for an icon.
  function tileBox(leaf, leaves, maxW) {
    let el = leaf;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (leaves.some((o) => o !== leaf && p.contains(o))) break;
      if (maxW && p.getBoundingClientRect().width > maxW * 1.15) break;
      el = p;
    }
    return el;
  }

  // Same idea by coordinates, for a cell that was already revealed when the grid
  // was captured, or whose element the site has since replaced.
  function boxAt(x, y, maxW) {
    let el = document.elementFromPoint(x, y);
    if (!el) return null;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (p.getBoundingClientRect().width > maxW * 1.15) break;
      el = p;
    }
    return el;
  }

  function captureGrid() {
    const rows = boardRows().slice(0, TILE_ROWS_MAX);
    const width = rows.reduce((n, r) => Math.max(n, r.tiles.length), 0);
    if (!rows.length || width < 3) return null;
    const cols = columnCenters(rows, width);
    if (cols.length !== width) return null;
    const span = Math.abs(cols[width - 1] - cols[0]) / (width - 1);
    const leaves = rows.flatMap((r) => r.tiles.map((t) => t.el));
    return rows.map((row) => {
      const r0 = row.tiles[0].el.getBoundingClientRect();
      const cy = r0.top + r0.height / 2;
      return {
        value: row.value,
        cells: cols.map((cx) => {
          const t = row.tiles.find((q) => Math.abs(q.cx - cx) < span / 2);
          const el = t ? tileBox(t.el, leaves, span) : boxAt(cx, cy, span);
          const r = el ? el.getBoundingClientRect() : null;
          return {
            el,
            w: r ? r.width : span,
            pageX: cx + window.scrollX,
            pageY: cy + window.scrollY,
          };
        }),
      };
    });
  }

  // Which of captureGrid's two ways out was taken, for the log line that says
  // the board could not be captured.
  function captureTrouble() {
    const rows = boardRows().slice(0, TILE_ROWS_MAX);
    const width = rows.reduce((n, r) => Math.max(n, r.tiles.length), 0);
    if (!rows.length) return "no rows of multipliers were found on the page";
    if (width < 3) return `the widest row has ${width} tile(s), not 3`;
    const cols = columnCenters(rows, width);
    if (cols.length !== width) {
      return `${rows.length} rows found but their columns do not line up`;
    }
    return `${rows.length} rows of ${width} found — reason unclear`;
  }

  function cellEl(c) {
    if (c.el && c.el.isConnected) return c.el;
    return boxAt(c.pageX - window.scrollX, c.pageY - window.scrollY, c.w || 60);
  }

  // A board as it reads right now: the signature of each cell, or null where
  // nothing could be read.
  function readGrid(grid) {
    return grid.map((row) => row.cells.map((c) => tileSig(cellEl(c)) || null));
  }

  // Why a board could not be read, in the four ways it can fail. "Nothing was
  // recorded" on its own does not say whether the tiles have gone from the page,
  // turned back face up, or are simply showing a picture nothing can be made of
  // — and those want three different fixes.
  function gridTrouble(grid) {
    const n = { read: 0, faceDown: 0, missing: 0, unreadable: 0 };
    for (const row of grid) {
      for (const c of row.cells) {
        const el = cellEl(c);
        if (!el) n.missing++;
        else if (MULT_RE.test(txt(el))) n.faceDown++;
        else if (tileSig(el)) n.read++;
        else n.unreadable++;
      }
    }
    return `${n.read} read, ${n.faceDown} face down, ${n.missing} gone, ${n.unreadable} unreadable`;
  }

  // How many tiles each kind of ending has ever shown. A bomb reveals the whole
  // board; a cashout shows only the tiles we took. Learning the ceiling
  // separately for each is what keeps the wait below from costing a second and a
  // half on every single round.
  const reveals = {
    win: { rounds: 0, best: 0, blank: 0 },
    bust: { rounds: 0, best: 0, blank: 0 },
  };
  const REVEAL_WAIT = 1500;

  // Read the board back once the round is over. The reveal is animated, so it is
  // sampled until it stops improving — but only for as long as it is still
  // plausible that more is coming.
  // Said once per page load. These are standing conditions rather than events —
  // repeating them every round would bury the log, and saying nothing at all is
  // what left the recorder looking like it was working when it was not running.
  const warned = new Set();
  function warnOnce(key, msg) {
    if (warned.has(key)) return;
    warned.add(key);
    log(msg);
  }

  // What became of the last dozen rounds, every one of them, however it ended.
  // The play log scrolls four lines a round and holds twenty-five, so anything
  // said once is gone within six rounds — no use for a fault that only shows up
  // after fifty. This is what Diagnose and the tile report read back.
  const recordLog = [];
  function noteRecord(line) {
    recordLog.push(line);
    if (recordLog.length > 12) recordLog.shift();
  }

  // Everything above works from a *description* of a tile. When that description
  // comes back empty there is no way to tell from the outside whether the tile
  // has gone, turned back over, or is showing something the description cannot
  // express — so the first time a board reads back short, keep the markup itself
  // for the row we picked from. Taken once, three cells, truncated: enough to
  // write the right reader against, small enough to paste.
  let sample = null;
  function sampleBoard(grid, picks, why) {
    if (sample) return;
    const row = grid[(picks[0] && picks[0].row) || 0];
    if (!row) return;
    sample = {
      why,
      buttonSays: buttonLabel() || "(not found)",
      cells: row.cells.slice(0, 3).map((c, i) => {
        const el = cellEl(c);
        if (!el) return `col ${i}: nothing at that point on the page`;
        return (
          `col ${i} <${el.tagName.toLowerCase()} class="${(el.getAttribute("class") || "").slice(0, 60)}"> ` +
          `text=${JSON.stringify(txt(el).slice(0, 30))} ` +
          `sig=${JSON.stringify(tileSig(el).slice(0, 60))}\n` +
          `  ${(el.outerHTML || "").replace(/\s+/g, " ").slice(0, 400)}`
        );
      }),
    };
    // Kept in storage, not just in the page: it is taken on a losing round and
    // is wanted later, quite possibly after a reload.
    try {
      api.storage.local.set({ sample });
    } catch (_) {}
  }

  async function recordRound(result, picks) {
    const grid = roundGrid;
    roundGrid = null;
    const kind = result === "win" ? "win" : "bust";
    const tag = `#${stats.rounds} ${kind}`;
    if (!cfg.recordTiles) {
      noteRecord(`${tag} — recording is switched off`);
      return warnOnce(
        "off",
        "Board recording is off — tick 'Record every revealed board' in the popup"
      );
    }
    if (!grid) {
      noteRecord(`${tag} — no board was captured at the start of the round`);
      return warnOnce("nogrid", "No board was captured for this round — nothing to read back");
    }
    try {
      const seen = reveals[kind];
      const learning = seen.rounds < 5; // still finding out how much this ending shows
      // Counted in tiles, not whole rows: a cashout reveals just the tiles we
      // took, and waiting on a full row would mean waiting out the timeout on
      // every winning round and then throwing the round away.
      const cells = grid.reduce((n, row) => n + row.cells.length, 0);
      let best = null;
      const t0 = Date.now();
      for (;;) {
        const rows = readGrid(grid);
        const known = rows.reduce((n, r) => n + r.filter(Boolean).length, 0);
        if (!best || known > best.known) best = { rows, known };
        // A read that came back completely blank never counts as enough, however
        // low the ceiling has been set. Otherwise one bad early sample teaches it
        // that this ending shows nothing, and it then stops waiting around long
        // enough to ever find out otherwise.
        const want = learning ? cells : Math.max(1, seen.best);
        if (best.known >= want || !running || Date.now() - t0 > REVEAL_WAIT) break;
        await sleep(150);
      }
      seen.rounds++;
      seen.best = Math.max(seen.best, best.known);
      if (!best.known) seen.blank++;
      // Worth saying out loud early: how much each ending shows decides what the
      // report can ever be built from, and it is invisible otherwise. A round
      // that reads back as nothing at all keeps saying so, occasionally, however
      // long it has been going on.
      if (seen.rounds <= 3 || seen.rounds % 200 === 0 || (!best.known && seen.blank % 25 === 1)) {
        log(
          `${kind === "win" ? "Cashout" : "Bomb"} revealed ${best.known}/${cells} tiles` +
            (best.known < cells ? ` — ${gridTrouble(grid)}` : "")
        );
      }
      // A bust is the only round that ever shows a whole board, so a bust that
      // reads back short is the one worth keeping the markup for.
      if (best.known < cells && kind === "bust") {
        sampleBoard(grid, picks, `${tag} read ${best.known} of ${cells} tiles`);
      }

      if (!best.known) {
        noteRecord(`${tag} 0/${cells} tiles — ${gridTrouble(grid)}`);
        return;
      }

      // The round really being over is what makes our own picks usable as ground
      // truth: a completed cashout means every tile we took was a gem, and a
      // board back on START after a bomb means the last one was not.
      //
      // The button lags the reveal, though, by a few hundred milliseconds after
      // a bomb — and a cashout waits for it, so only busts ever arrive here
      // early. Reading it once, immediately, stamped those rounds "outcome
      // unknown", and an unknown round teaches the classifier nothing. Since a
      // bust is the only round that ever shows it a bomb, the bomb never got a
      // name, and a picture with no name is not counted at all: the hit rate sat
      // at a confident 0 out of however many gems it had seen. So wait for it.
      let ended = gameState() === "idle";
      for (let i = 0; !ended && i < 10 && running; i++) {
        await sleep(150);
        ended = gameState() === "idle";
      }

      const outcome = ended ? (result === "win" ? "w" : "b") : "?";
      noteRecord(
        `${tag} ${best.known}/${cells} tiles, outcome ${outcome}` +
          (best.known < cells ? ` — ${gridTrouble(grid)}` : "")
      );
      // Won and lost alike, and in the order they were played: which tile of a
      // row was the bomb only means anything alongside how that round ended, and
      // a history with the losses left out could not name a bomb at all.
      keep({
        seq: ++seq,
        session,
        t: Date.now(),
        round: stats.rounds,
        outcome,
        picks: picks.map((p) => ({ row: p.row, col: p.col, saw: p.saw })),
        width: best.rows.reduce((w, r) => Math.max(w, r.length), 0),
        board: best.rows,
        read: best.known,
        cells,
      });
    } catch (err) {
      noteRecord(`${tag} — threw: ${err.message}`);
      log(`Could not record the board: ${err.message}`);
    }
  }

  // Rounds recorded by the build that stored boards as indexes into a table of
  // pictures. They are worth carrying rather than dropping — several hundred
  // rounds of real play — and once resolved back to signatures they are ordinary
  // records. Two things are recovered on the way past:
  //
  //  - a cell that no picture could be made of was a bomb, which had no picture
  //    to make. A row holding exactly one such cell among otherwise readable
  //    ones is that row, and rows not of that shape are left unread.
  //  - they carry no clock, so they are stamped before any live round and kept
  //    in the order they were played, which is the order the collector needs.
  function adoptOldLog(old) {
    const dict = old.dict;
    const carried = [];
    for (const r of old.log) {
      const board = r.b.map((row) => {
        const cells = row.map((i) => (i >= 0 && dict[i] ? dict[i] : null));
        const unread = cells.filter((c) => !c).length;
        if (unread === 1 && cells.length >= 3) cells[cells.indexOf(null)] = BLANK_SIG;
        return cells;
      });
      carried.push({
        seq: ++seq,
        session: `${session}-carried`,
        t: 0, // before anything played since; ordering falls back to seq
        round: r.n,
        outcome: r.r,
        picks: (r.p || []).map((p) => ({
          row: p[0],
          col: p[1],
          saw: p[2] === 1 ? "bomb" : "gem",
        })),
        width: board.reduce((w, row) => Math.max(w, row.length), 0),
        board,
        read: board.reduce((n, row) => n + row.filter(Boolean).length, 0),
        cells: board.reduce((n, row) => n + row.length, 0),
        carried: true,
      });
    }
    // In front of this run's own rounds, since that is when they were played.
    history.unshift(...carried);
    unsent = history.length;
    return carried.length;
  }

  function keep(record) {
    history.push(record);
    unsent++;
    if (history.length > HISTORY_MAX) {
      const dropped = history.splice(0, history.length - HISTORY_MAX).length;
      // Only reachable with the collector down for thousands of rounds. Say so:
      // rounds falling off the end unremarked is the one way this loses data.
      if (unsent > history.length) {
        unsent = history.length;
        warnOnce(
          "dropped",
          `The collector has been unreachable long enough to lose ${dropped} rounds`
        );
      }
    }
    saveHistory();
    if (unsent >= EXPORT_EVERY) flush();
  }

  function saveHistory() {
    try {
      api.storage.local.set({ history, unsent, seq, session });
    } catch (_) {}
  }

  // Send whatever has not been acknowledged, oldest first. Nothing is marked
  // sent until the collector says it stored it, so a collector that is down, or
  // a reply that goes missing, costs a repeated batch rather than a lost one —
  // and the collector files each round under session and number, so a repeat is
  // recognised and dropped there rather than counted twice.
  async function flush(reason) {
    if (flushing || !unsent) return;
    flushing = true;
    const batch = history.slice(history.length - unsent);
    try {
      const res = await deliver(batch);
      if (res && res.ok) {
        unsent = Math.max(0, unsent - batch.length);
        collector = { ok: true, at: Date.now(), summary: res.summary, text: res.text };
        saveHistory();
        log(
          `Exported ${res.stored} rounds` +
            (res.duplicates ? ` (${res.duplicates} already filed)` : "") +
            ` — ${res.total} collected in all`
        );
      } else {
        const why = (res && res.error) || "no answer from the extension worker";
        collector = { ok: false, at: Date.now(), error: why };
        warnOnce("collector", `Holding ${unsent} rounds — ${why}`);
      }
    } catch (err) {
      collector = { ok: false, at: Date.now(), error: err.message };
    } finally {
      flushing = false;
    }
    if (reason === "stop") renderHud();
  }

  // https first, because a page served over https may not open a plain-http
  // connection — the browser refuses it before the request is made. http is
  // still tried behind it, for a collector running without a certificate where
  // something else has permitted the connection.
  const COLLECTOR_URLS = [
    "https://localhost:8765/rounds",
    "http://localhost:8765/rounds",
  ];

  // Two ways to the collector, tried in turn, because which of them a browser
  // permits is not something that can be known from here.
  //
  // The worker is the right place for it: a page served over https may not be
  // allowed to open a plain-http connection, and the worker is not part of the
  // page. But if the worker does not answer, going directly costs nothing — and
  // when both fail, the two errors together say which wall was hit, which is the
  // difference between a worker that never loaded and a request that was
  // refused before it was made.
  async function deliver(records) {
    const tried = [];
    for (const url of COLLECTOR_URLS) {
      const viaWorker = await ask({ type: "export", url, records });
      if (viaWorker && viaWorker.ok) return viaWorker;
      tried.push(`worker ${scheme(url)}: ${(viaWorker && viaWorker.error) || "no answer"}`);

      const direct = await postDirect(url, records);
      if (direct.ok) return direct;
      tried.push(`page ${scheme(url)}: ${direct.error}`);
    }
    return { ok: false, error: tried.join(" · ") };
  }

  const scheme = (url) => url.slice(0, url.indexOf(":"));

  async function postDirect(url, records) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records }),
      });
      if (!res.ok) return { ok: false, error: `answered ${res.status}` };
      const body = await res.json();
      return body && body.ok
        ? { ...body, ok: true }
        : { ok: false, error: "batch refused" };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  function ask(msg) {
    return new Promise((resolve) => {
      let done = false;
      const settle = (v) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      setTimeout(() => settle(null), 8000);
      try {
        // Safari answers this either by calling the callback or by resolving
        // what it returns, depending on which namespace is in play. Taking
        // whichever arrives first costs nothing and stops a worker that replied
        // perfectly well from looking like one that never answered.
        const maybe = api.runtime.sendMessage(msg, (resp) => {
          void api.runtime.lastError;
          settle(resp || null);
        });
        if (maybe && typeof maybe.then === "function") {
          maybe.then((resp) => settle(resp || null), () => settle(null));
        }
      } catch (_) {
        settle(null);
      }
    });
  }

  /* ------------------------------------------------------------ collected */

  // The statistics used to live here. They are pure functions over the rounds
  // — no page, no DOM — so they moved to the collector, where they run over the
  // whole file instead of the last few thousand rounds a browser can hold, and
  // where a change of mind about what a picture means is a re-read rather than a
  // rebuild and a migration. What comes back is shown as-is.
  function collectedReport() {
    if (collector && collector.ok && collector.text) return collector.text;
    const lines = [];
    if (collector && !collector.ok) {
      lines.push("The collector could not be reached:");
      lines.push(`  ${collector.error}`);
      lines.push("");
      lines.push("Start it with:  node server/collect.js");
      lines.push(`${unsent} round(s) are being held until it answers.`);
    } else {
      lines.push(`Nothing sent yet — a batch goes out every ${EXPORT_EVERY} rounds.`);
      lines.push(`${history.length} round(s) recorded, ${unsent} waiting.`);
      lines.push("");
      lines.push("Start the collector with:  node server/collect.js");
    }
    lines.push("");
    lines.push(...recentRecords());
    return lines.join("\n");
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

    // Which column that turned out to be, counted across the whole grid rather
    // than within this row — a row missing a tile would otherwise mis-number it.
    const width = rows.reduce((n, r) => Math.max(n, r.tiles.length), 0);
    const cols = columnCenters(rows, width);
    const col = cols.length
      ? cols.reduce(
          (best, cx, i) =>
            Math.abs(cx - target.cx) < Math.abs(cols[best] - target.cx) ? i : best,
          0
        )
      : -1;

    const label = Number.isFinite(row.value) ? `x${row.value}` : `row ${rowIndex + 1}`;
    const totalBefore = rows.reduce((n, r) => n + r.tiles.length, 0);
    setStatus(`Picking middle tile of ${label}`);
    log(`Pick ${rowIndex + 1} → middle of ${label}`);

    const seen = (result) => ({ result, col });
    realClick(target.el);
    let lastClick = Date.now();
    let attempts = 1;
    const deadline = Date.now() + 15000;
    let lastTotal = totalBefore;
    let changedAt = 0;

    for (;;) {
      checkAbort(token);

      // Round over -> the button flipped back to START, i.e. we hit a bomb.
      if (gameState() === "idle") return seen("bomb");

      const total = multTiles().length;
      // Whole board revealed -> no multipliers left anywhere, also a bomb.
      if (total === 0) return seen("bomb");
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
          if (gameState() === "idle") return seen("bomb");
          // exactly our tile went -> gem; anything more -> the board is opening up
          return seen(total === totalBefore - 1 ? "gem" : "bomb");
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
      // The rows already picked are short a tile, so this snapshot fills those
      // cells in by position — a resumed round is still worth recording.
      if (!roundGrid && cfg.recordTiles) roundGrid = captureGrid();
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
      if (stats.startBalance === null) stats.startBalance = balance;
      if (cfg.minBalance > 0 && balance <= cfg.minBalance) {
        return stop(`Balance ${balance} reached your floor of ${cfg.minBalance}`);
      }
      if (bet !== null && balance < bet) {
        return stop(`Balance ${balance} is below the bet of ${bet} — out of funds`);
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
    // Take the grid now, while every tile still shows a multiplier and can be
    // found by text. After this the board can only be read through these refs.
    roundGrid = cfg.recordTiles ? captureGrid() : null;
    if (cfg.recordTiles && !roundGrid) {
      warnOnce("capture", `The board could not be captured — ${captureTrouble()}`);
    }
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
    const picks = [];
    for (let i = from; i < PICKS; i++) {
      const pick = await pickTile(token, i);
      picks.push({ row: i, col: pick.col, saw: pick.result });
      if (pick.result === "bomb") {
        stats.busts++;
        if (i === 0) stats.firstPickLosses++;
        else stats.secondPickLosses++;
        roundOpen = false;
        log(`Round ${stats.rounds}: bomb on pick ${i + 1}`);
        await recordRound("bust", picks);
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
    await recordRound("win", picks);
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
          return stop(`Gave up after ${errors} failed recoveries — ${err.message}`);
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
    running = true;
    stopReason = "";
    const token = ++loopToken;
    // Only take the baseline the first time, so pausing and resuming continues
    // the same session instead of zeroing Net. "Reset stats" re-baselines.
    const bal = findBalance();
    if (bal !== null) {
      stats.balance = bal;
      if (stats.startBalance === null) stats.startBalance = bal;
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
    releaseWakeLock();
    stopReason = reason || "Paused";
    log(`Stopped — ${stopReason}`);
    setStatus(`Stopped: ${stopReason}`);
    persist();
    saveStats();
    // Whatever has been played since the last batch goes now rather than
    // sitting in the browser until fifty more rounds that may never come.
    if (unsent) flush("stop");
  }

  function persist() {
    try {
      api.storage.local.set({ ...cfg, running });
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
      tiles: {
        rounds: history.length,
        unsent,
        sending: collector ? collector.ok : null,
        ...((collector && collector.summary) || { hits: 0, picks: 0, ready: false }),
      },
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
        /* Why the collector is not being reached, kept on screen rather than in
           the log: it is a standing condition, and the log scrolls past it. */
        .why { margin-top:7px; font-size:10.5px; line-height:1.35; color:#e0b48a;
               background:#3a2a20; border:1px solid #6b4a2e; border-radius:5px;
               padding:5px 7px; display:none; word-break:break-word; }
        .why.show { display:block; }
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
            <span class="k">Collected</span><span class="v" data-k="hit">–</span>
          </div>
          <div class="why" data-k="why"></div>
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
    const why = q('[data-k="why"]');
    if (collector && !collector.ok) {
      why.textContent = `Collector unreachable — ${collector.error}`;
      why.classList.add("show");
    } else {
      why.classList.remove("show");
    }

    // How many rounds the collector holds, not what it makes of them. The
    // reading of them is a report, and a report belongs where you can sit and
    // read it; what is worth a line on the page is whether the rounds are
    // getting out of the browser at all.
    const s = collector && collector.ok ? collector.summary : null;
    q('[data-k="hit"]').textContent = s
      ? `${s.rounds}${unsent ? ` +${unsent}` : ""}`
      : collector
        ? `holding ${unsent}`
        : unsent
          ? `${unsent} waiting`
          : "–";
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
        startBalance: findBalance(),
      });
      stats.balance = stats.startBalance;
      logLines.length = 0;
      saveStats();
      renderHud();
      sendResponse(snapshot());
    } else if (msg.type === "tileReport") {
      sendResponse({ text: collectedReport() });
    } else if (msg.type === "exportNow") {
      flush("manual");
      sendResponse({
        text: unsent
          ? `Sending ${unsent} round(s) — press Tile report in a moment.`
          : "Everything recorded has already been collected.",
      });
    } else if (msg.type === "tileData") {
      // The rounds still held in the browser, with the recorder's own account of
      // the last few, which is what is wanted when the history is empty and the
      // question is why.
      sendResponse({
        json: JSON.stringify(
          { session, seq, unsent, collector, recent: recordLog, sample, reveals, history },
          null,
          1
        ),
        rounds: history.length,
        recent: recordLog.length,
      });
    } else if (msg.type === "resetTiles") {
      history.length = 0;
      unsent = 0;
      collector = null;
      sample = null;
      recordLog.length = 0;
      api.storage.local.remove("sample");
      reveals.win = { rounds: 0, best: 0, blank: 0 };
      reveals.bust = { rounds: 0, best: 0, blank: 0 };
      saveHistory();
      renderHud();
      // The collector's file is left alone on purpose: it is the record, and
      // clearing a browser buffer is not a reason to throw the history away.
      sendResponse({ text: "Cleared what the browser was holding. The collector's file is untouched." });
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
        recorder: {
          on: cfg.recordTiles,
          gridCaptured: !!roundGrid,
          heldInBrowser: history.length,
          waitingToSend: unsent,
          sendsEvery: EXPORT_EVERY,
          collector: collector
            ? collector.ok
              ? `answered — ${(collector.summary || {}).rounds} rounds collected`
              : `unreachable — ${collector.error}`
            : "not tried yet",
          tilesRevealed: `bomb ${reveals.bust.best} (${reveals.bust.rounds} seen), ` +
            `cashout ${reveals.win.best} (${reveals.win.rounds} seen)`,
          lastRounds: recordLog.slice(),
        },
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
    }
    if (Array.isArray(saved.log)) logLines.push(...saved.log.slice(-40));
    if (saved.sample) sample = saved.sample;

    // Anything stored by an older build must not be able to take the bot down
    // with it: the play loop does not need a single line of this to work.
    try {
      if (Array.isArray(saved.history)) {
        history.push(...saved.history);
        seq = Number(saved.seq) || history.length;
        // Everything the last run had not had acknowledged is still owed, and a
        // batch already filed is recognised by the collector and dropped there,
        // so erring towards sending again is the safe direction.
        unsent = Math.min(history.length, Math.max(0, Number(saved.unsent) || 0));
      }
      const old = saved.tiles;
      if (old && Array.isArray(old.dict) && Array.isArray(old.log) && old.log.length) {
        const n = adoptOldLog(old);
        log(`Carried ${n} rounds recorded by an earlier build over to the collector`);
        api.storage.local.remove("tiles");
      }
      saveHistory();
      // Whatever is owed goes out now rather than waiting for another fifty
      // rounds — after a reload that could be a long time, and after the
      // carry-over above there may be hundreds of them.
      if (unsent) flush("startup");
    } catch (err) {
      log(`Stored rounds could not be read (${err.message}) — use Clear boards`);
    }

    // Keep the restored baseline but show the balance as it is right now.
    const bal = findBalance();
    if (bal !== null) stats.balance = bal;

    const wasRunning = !!saved.running;
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
