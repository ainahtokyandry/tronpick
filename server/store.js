"use strict";

/* The file the rounds live in: one JSON object per line, appended, never
 * rewritten. Append-only is deliberate — the whole reason the raw signatures
 * are kept is so an interpretation can be changed and the history re-read under
 * it. A file that gets rewritten in place cannot offer that.
 */

const fs = require("fs");
const path = require("path");

const FILE = process.env.ROUNDS_FILE || path.join(__dirname, "rounds.jsonl");

const key = (r) => `${r.session}:${r.seq}`;

function readRounds() {
  if (!fs.existsSync(FILE)) return [];
  const seen = new Set();
  const out = [];
  for (const line of fs.readFileSync(FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch (_) {
      continue; // a half-written final line after a kill; the next append fixes it
    }
    if (!r || typeof r.seq !== "number" || !r.session) continue;
    if (seen.has(key(r))) continue;
    seen.add(key(r));
    out.push(r);
  }
  return out;
}

// Rounds already on file are skipped rather than written twice: a batch is
// re-sent whenever the collector was down or the reply went missing, and the
// same round arriving again must not become two rounds in the statistics.
function appendRounds(incoming, seen) {
  const fresh = [];
  for (const r of incoming) {
    if (!r || typeof r.seq !== "number" || !r.session || !Array.isArray(r.board)) continue;
    if (seen.has(key(r))) continue;
    seen.add(key(r));
    fresh.push(r);
  }
  if (fresh.length) {
    fs.appendFileSync(FILE, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return fresh;
}

module.exports = { FILE, key, readRounds, appendRounds };
