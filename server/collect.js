#!/usr/bin/env node
"use strict";

/* Receives batches of finished rounds from the extension and appends them to
 * rounds.jsonl. Nothing leaves this machine: the extension talks to localhost.
 *
 *   node server/collect.js          collect on :8765 into server/rounds.jsonl
 *   node server/report.js           print the report from that file
 *
 * The reply to each batch carries the current headline figures back, which is
 * what the on-page panel shows — so the naming of gem and bomb is worked out
 * here, in one place, over the whole history rather than over the last thousand
 * rounds a browser could hold.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { FILE, key, readRounds, appendRounds } = require("./store");
const { analyse, format, summary } = require("./report");

const PORT = Number(process.env.PORT || 8765);

// https when there is a certificate to serve it with, plain http otherwise. The
// game is served over https and a page served over https may not open a
// plain-http connection, so http only ever works for curl and the browser you
// open the report in — not for the extension. `./server/setup-cert.sh` makes the
// certificate.
const CERT = path.join(__dirname, "cert.pem");
const KEY = path.join(__dirname, "key.pem");
const secure = fs.existsSync(CERT) && fs.existsSync(KEY);

const records = readRounds();
const seen = new Set(records.map(key));
console.log(`${FILE}\nloaded ${records.length} rounds`);

// Recomputed after a batch lands, not on every request: the analysis is cheap
// but a report page refreshed in a loop should not be able to make it the
// bottleneck.
let cached = null;
const report = () => (cached = cached || analyse(records));

function cors(res) {
  // The page is served from tronpick.io, so the browser asks first.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function send(res, code, body, type = "application/json") {
  cors(res);
  res.writeHead(code, { "Content-Type": `${type}; charset=utf-8` });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const escape = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function page(text) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Gems — ${records.length} rounds</title>
<meta http-equiv="refresh" content="5">
<style>
  :root { color-scheme: dark light; }
  body { margin:0; padding:24px; background:#12181f; color:#dbe6f0;
         font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { margin:0; white-space:pre-wrap; }
  .foot { margin-top:18px; color:#6d8296; font-size:11.5px; }
</style></head><body>
<pre>${escape(text)}</pre>
<p class="foot">Refreshes every 5s · ${records.length} rounds on file</p>
</body></html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > 8 * 1024 * 1024) {
        reject(new Error("batch too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const handler = async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, "");

  if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/report"))) {
    const text = format(report());
    // A browser gets a page that refreshes itself, since the natural thing to do
    // with this is leave it open while the rounds come in. Anything else — curl,
    // a pipe — gets the plain text it asked for.
    if ((req.headers.accept || "").includes("text/html")) {
      return send(res, 200, page(text), "text/html");
    }
    return send(res, 200, text, "text/plain");
  }

  if (req.method === "GET" && req.url.startsWith("/health")) {
    return send(res, 200, { ok: true, rounds: records.length, file: FILE });
  }

  if (req.method === "POST" && (req.url === "/" || req.url.startsWith("/rounds"))) {
    let batch;
    try {
      batch = JSON.parse(await readBody(req));
    } catch (err) {
      return send(res, 400, { ok: false, error: `unreadable batch: ${err.message}` });
    }
    const incoming = Array.isArray(batch) ? batch : batch && batch.records;
    if (!Array.isArray(incoming)) {
      return send(res, 400, { ok: false, error: "expected {records: [...]}" });
    }
    let fresh = [];
    try {
      fresh = appendRounds(incoming, seen);
    } catch (err) {
      // Storage is the one thing worth failing loudly on: answering "ok" to a
      // batch that was never written would have the extension drop it.
      console.error(`could not append: ${err.message}`);
      return send(res, 500, { ok: false, error: `could not append: ${err.message}` });
    }
    if (fresh.length) {
      records.push(...fresh);
      cached = null;
      const r = report();
      console.log(
        `+${fresh.length} (${incoming.length - fresh.length} already had) ` +
          `-> ${records.length} rounds · bomb on ours ${r.hits}/${r.judged}` +
          (r.ready ? "" : " (still learning)")
      );
    }
    // The report travels back with the reply so the popup can show it without
    // holding any of the statistics itself.
    return send(res, 200, {
      ok: true,
      stored: fresh.length,
      duplicates: incoming.length - fresh.length,
      total: records.length,
      summary: summary(report()),
      text: format(report()),
    });
  }

  send(res, 404, { ok: false, error: "try GET / or POST /rounds" });
};

const server = secure
  ? https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, handler)
  : http.createServer(handler);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`port ${PORT} is already in use — is a collector already running?`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`listening on ${secure ? "https" : "http"}://localhost:${PORT}`);
  if (!secure) {
    console.log("");
    console.log("No certificate, so this is plain http — which the extension");
    console.log("cannot reach from an https page. Run ./server/setup-cert.sh");
    console.log("first, then start this again.");
  }
  console.log("GET / for the report, POST /rounds to add");
});
