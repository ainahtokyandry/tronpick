"use strict";

/* The statistics, over the rounds the extension has sent.
 *
 * Nothing here knows anything about a web page. A record is: how the round
 * ended, which tiles we took, and what every cell of the board was showing —
 * each cell a signature string, or null where nothing could be read. Which
 * signature is a gem and which is a bomb is worked out from our own picks, the
 * only tiles whose outcome is not in doubt, and it is re-derived from the whole
 * file every time. That is the point of keeping the raw signatures: an
 * interpretation can be changed and the entire history re-read under it, with
 * nothing to migrate and nothing overwritten.
 */

// The order things happened in, which is what makes a pick's outcome mean
// anything. Appends arrive in order, but a retry after the collector was down
// can carry an older batch in behind a newer one, so it is imposed rather than
// assumed.
function inOrder(records) {
  return records
    .slice()
    .sort((a, b) => (a.t || 0) - (b.t || 0) || a.seq - b.seq);
}

// Which picture is a bomb, learned only from tiles we picked ourselves: a
// completed cashout means every tile taken was a gem, a board back on START
// after a bomb means the last one was not. Nine sightings out of ten have to
// agree before a picture gets a name.
function labelSigs(records) {
  const counts = new Map();
  for (const r of records) {
    if (r.outcome !== "w" && r.outcome !== "b") continue;
    const picks = r.picks || [];
    picks.forEach((p, i) => {
      const row = r.board[p.row];
      const sig = row ? row[p.col] : null;
      if (!sig) return;
      if (!counts.has(sig)) counts.set(sig, { gem: 0, bomb: 0 });
      counts.get(sig)[r.outcome === "b" && i === picks.length - 1 ? "bomb" : "gem"]++;
    });
  }
  const labels = new Map();
  for (const [sig, c] of counts) {
    const n = c.gem + c.bomb;
    if (n < 3) continue; // too few sightings to call it either way
    if (c.bomb >= n * 0.9) labels.set(sig, "bomb");
    else if (c.gem >= n * 0.9) labels.set(sig, "gem");
  }
  return labels;
}

/* ------------------------------------------------------------------- tests */

// 1 − Φ(z), the standard normal upper tail (Abramowitz & Stegun 26.2.17).
function tailP(z) {
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? p : 1 - p;
}

const twoSided = (z) => Math.min(1, 2 * tailP(Math.abs(z)));

function chiP(x, df) {
  if (df <= 0 || x <= 0) return 1;
  if (df % 2 === 0) {
    // exact for an even number of degrees of freedom, which df=2 (three columns) is
    let sum = 1;
    let term = 1;
    for (let k = 1; k < df / 2; k++) {
      term *= x / (2 * k);
      sum += term;
    }
    return Math.min(1, Math.exp(-x / 2) * sum);
  }
  // Wilson–Hilferty, close enough for the odd case
  const z = (Math.pow(x / df, 1 / 3) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  return tailP(z);
}

// Are bombs spread evenly over the columns? `seen` is how many tiles each
// column contributed, so a column read less often than the others still gets a
// fair expectation rather than being flagged for it.
function chiSquare(bomb, seen) {
  const nb = bomb.reduce((a, b) => a + b, 0);
  const ns = seen.reduce((a, b) => a + b, 0);
  if (!nb || !ns) return { x: 0, p: 1, df: 0 };
  let x = 0;
  for (let i = 0; i < bomb.length; i++) {
    const e = (nb * seen[i]) / ns;
    if (e > 0) x += ((bomb[i] - e) * (bomb[i] - e)) / e;
  }
  return { x, p: chiP(x, bomb.length - 1), df: bomb.length - 1 };
}

function twoProp(a, na, b, nb) {
  if (!na || !nb) return null;
  const p = (a + b) / (na + nb);
  const se = Math.sqrt(p * (1 - p) * (1 / na + 1 / nb));
  if (!se) return null;
  const z = (a / na - b / nb) / se;
  return { z, p: twoSided(z) };
}

/* ---------------------------------------------------------------- analysis */

function analyse(input) {
  const records = inOrder(input);
  const labels = labelSigs(records);
  const width = records.reduce(
    (w, r) => r.board.reduce((m, row) => Math.max(m, row.length), w),
    0
  );

  // Only rows we never touched are counted, and that restriction is the whole
  // trick. A row we did pick from is fully revealed exactly when the tile we
  // took was the bomb — that is what ended the round — so its bomb sits in our
  // column by definition. Counting those rows would report the column we click
  // as 100% bombs however fair the board is. What clicking does is measured
  // separately, by putting our own tiles against these rows.
  const untouched = {
    bomb: new Array(width).fill(0),
    seen: new Array(width).fill(0),
  };
  const pickCol = new Array(width).fill(0);
  let rows = 0;
  let touched = 0;
  let unreadable = 0;
  let hits = 0;
  let judged = 0;
  let agree = 0;
  let disagree = 0;
  const outcomes = { w: 0, b: 0, "?": 0 };

  for (const r of records) {
    outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
    const picks = r.picks || [];
    const mine = new Set(picks.map((p) => p.row));

    r.board.forEach((row, i) => {
      if (row.every((c) => !c)) return; // never revealed
      if (mine.has(i)) {
        touched++;
        return;
      }
      if (row.length !== width || row.some((c) => !c || !labels.has(c))) {
        unreadable++;
        return;
      }
      rows++;
      row.forEach((c, col) => {
        untouched.seen[col]++;
        if (labels.get(c) === "bomb") untouched.bomb[col]++;
      });
    });

    for (const p of picks) {
      if (p.col >= 0 && p.col < width) pickCol[p.col]++;
      const row = r.board[p.row];
      const sig = row ? row[p.col] : null;
      if (!sig || !labels.has(sig)) continue;
      judged++;
      const bomb = labels.get(sig) === "bomb";
      if (bomb) hits++;
      if (bomb === (p.saw === "bomb")) agree++;
      else disagree++;
    }
  }

  const rate = {
    bomb: untouched.bomb.reduce((a, b) => a + b, 0),
    seen: untouched.seen.reduce((a, b) => a + b, 0),
  };
  const named = [...labels.values()];

  return {
    rounds: records.length,
    first: records.length ? records[0].t : null,
    last: records.length ? records[records.length - 1].t : null,
    outcomes,
    width,
    rows,
    touched,
    unreadable,
    untouched,
    untouchedRate: rate,
    pickCol,
    hits,
    judged,
    agree,
    disagree,
    ready: named.includes("gem") && named.includes("bomb"),
    labels: [...labels].map(([sig, name]) => ({ sig, name })),
    vsUntouched: twoProp(hits, judged, rate.bomb, rate.seen),
  };
}

/* ----------------------------------------------------------------- wording */

const COL_NAMES = { 3: ["L", "M", "R"], 2: ["L", "R"] };

function format(r) {
  if (!r.rounds) return "No rounds collected yet.";
  const names = COL_NAMES[r.width] || r.untouched.seen.map((_, i) => String(i + 1));
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : "–");
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const out = [];

  out.push(`Rounds collected ${r.rounds}  (${r.outcomes.w || 0} won, ${r.outcomes.b || 0} lost` +
    (r.outcomes["?"] ? `, ${r.outcomes["?"]} unknown` : "") + ")");
  out.push(
    `Untouched rows   ${r.rows}` + (r.unreadable ? ` (${r.unreadable} unreadable)` : "")
  );
  for (const l of r.labels) out.push(`${l.name.padEnd(5)}= ${l.sig.slice(0, 34)}`);

  if (!r.rows) {
    out.push("");
    out.push("Nothing to count yet — both pictures have to be");
    out.push("named first, which takes three wins and three");
    out.push("losses.");
    return out.join("\n");
  }

  const c = chiSquare(r.untouched.bomb, r.untouched.seen);
  out.push("");
  out.push("Bomb rate by column, rows we never touched");
  out.push(
    ` ${r.untouched.bomb.map((b, i) => `${names[i]} ${pct(b, r.untouched.seen[i])}%`).join("  ")}`
  );
  out.push(` n=${sum(r.untouched.seen)}  chi2=${c.x.toFixed(2)}  p=${c.p.toFixed(3)}`);

  out.push("");
  out.push(`Bomb on our tile ${r.hits}/${r.judged} = ${pct(r.hits, r.judged)}%`);
  if (r.vsUntouched) {
    out.push(`  untouched rows ${pct(r.untouchedRate.bomb, r.untouchedRate.seen)}%`);
    out.push(`  z=${r.vsUntouched.z.toFixed(2)}  p=${r.vsUntouched.p.toFixed(3)}`);
  }
  out.push(`We clicked  ${r.pickCol.map((n, i) => `${names[i]} ${n}`).join("  ")}`);
  out.push(`Live call vs board  ${r.agree} ok, ${r.disagree} wrong`);

  out.push("");
  out.push(verdict(r, c));
  return out.join("\n");
}

// p-values are only worth reading out loud once there is enough data behind
// them, so the wording leans on the sample size as much as on the test.
function verdict(r, chi) {
  const vs = r.vsUntouched;
  const lines = [];

  if (r.judged < 200 || r.rows < 200) {
    lines.push("VERDICT: too early. A few hundred rounds are");
    lines.push("needed before any of this means anything.");
    lines.push("Nothing so far is out of the ordinary.");
  } else if (chi.p < 0.01 || (vs && vs.p < 0.01)) {
    lines.push("VERDICT: the columns are NOT behaving alike.");
    lines.push("Where you click matters — moving off the");
    lines.push("middle column is worth testing.");
  } else if (chi.p < 0.05 || (vs && vs.p < 0.05)) {
    lines.push("VERDICT: a mild wobble, the kind that turns up");
    lines.push("by chance about one run in twenty. Keep");
    lines.push("recording before reading anything into it.");
  } else {
    lines.push("VERDICT: the bomb lands on every column equally");
    lines.push("often, and the column we keep clicking is no");
    lines.push("different from the ones we never touch.");
    lines.push("Staying on the middle tile is indifferent —");
    lines.push("switching columns gains nothing.");
  }
  if (r.disagree > Math.max(3, 0.02 * r.judged)) {
    lines.push("");
    lines.push(`WARNING: ${r.disagree} of ${r.judged} picks were called wrong`);
    lines.push("during play, so the board and the live call");
    lines.push("disagree. Trust the figures here.");
  }
  return lines.join("\n");
}

// The headline the extension shows on the page, small enough to travel back in
// the reply to every batch.
function summary(r) {
  return {
    rounds: r.rounds,
    hits: r.hits,
    picks: r.judged,
    ready: r.ready,
    rows: r.rows,
  };
}

module.exports = { analyse, format, summary, inOrder, chiSquare, twoProp };

if (require.main === module) {
  const { readRounds, FILE } = require("./store");
  const records = readRounds();
  console.log(`${FILE}\n`);
  console.log(format(analyse(records)));
}
