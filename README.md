# TronPick Gems Autoplay

A Safari web extension that plays the gems tower on `https://tronpick.io/gems.php`
automatically.

## The strategy

Fixed:

1. Click **START**
2. Click the **middle tile of the bottom row** (x1.46 on Easy)
3. If it is a gem, click **CASHOUT**
4. Repeat

A bomb ends the round, and the next round starts on its own. The loop keeps
going until you pause it or a stop condition fires.

One row per round is deliberate. The ladder charges roughly 3% of the stake for
every row climbed, so stopping at x1.46 loses about 2.7% of the stake per round
against 5.8% for cashing out at x2.12 — a little over twice the runtime from the
same balance. Change `PICKS` in `extension/content.js` to climb further.

Difficulty and everything else stay exactly as you left them on the page. The bet
is typed in before each round: `0.02` unless you set another in the popup.

## Install

Requires Xcode (already used to produce the project under `xcode/`) and Node.

```bash
./server/setup-cert.sh    # once: lets the browser reach the collector
node server/collect.js    # leave running while you play
./build.sh run
```

`build.sh` syncs `extension/` into the Xcode target, builds a Release app, and
opens it so Safari registers the extension. Then, in Safari:

1. **Settings → Advanced →** tick *Show features for web developers*
2. **Develop → Allow Unsigned Extensions**  — the build is ad-hoc signed, so this
   is required, and it resets every time Safari quits
3. **Settings → Extensions →** enable *TronPick Gems Autoplay*
4. Give it access to `tronpick.io` **and** to `localhost` — the second is how the
   rounds reach the collector

Reload `https://tronpick.io/gems.php`.

> Turning the extension off and on again in Safari's Extensions panel **clears
> its storage**. Any rounds the collector has not taken yet are lost with it, so
> press **Copy data** first, or make sure the collector is running.

## Use

Two equivalent controls:

- The **panel on the page**, bottom-right: status, counters, Start/Pause, and a
  `☰` button that expands a running log. *Collected* is how many rounds the
  collector holds, and `+7` beside it how many are still waiting to be sent. If
  the collector cannot be reached it says so there, in amber, with the reason.
  What the rounds *mean* is not on the panel — that is **Tile report**.
- The **toolbar popup**, which adds the settings and the buttons below.

| Button | What it does |
| --- | --- |
| Reset stats | Zeroes the counters and the Net baseline. Recorded rounds are untouched. |
| Diagnose | What the page looks like right now: the button, the rows, which input it takes for the bet, the balance, and how the recorder is getting on. |
| Tile report | The collector's report, as it comes back. If the collector is down, why. |
| Copy data | The rounds still held in the browser, plus the recorder's notes on the last dozen. |
| Export now | Send whatever is waiting, without waiting for fifty rounds. |
| Clear boards | Empties the browser's buffer. The collector's file is left alone. |

### Settings

| Field | Meaning |
| --- | --- |
| Bet amount | Typed into the page's bet field before each round. Blank = `0.02`. |
| Below balance / …bet this instead | Step the stake down once the balance drops under the threshold, e.g. `0.5` and `0.01`. It steps back up if the balance recovers. |
| Stop below balance | Halt once the wallet balance falls to or under this. |
| Take profit / Stop loss | Halt once net profit/loss for the session crosses this. Blank = off. |
| Max rounds | Halt after this many rounds. Blank = unlimited. |
| Delay between rounds | Milliseconds of pause after each round. |
| Record every revealed board | Store the board that is revealed at the end of each round, so **Tile report** can test it for column bias. |

It also stops on its own when the balance drops below one bet, or if START stops
opening a round — that is the "money ran out" case.

### Recovering instead of stopping

A step that times out no longer ends the session. The loop re-reads the page and
carries on from whatever it finds: if a round is still open it works out how many
tiles have already been picked — by counting rows that are short a tile, bottom
up — and resumes at the next one, or cashes out if both are already gems. A live
stake is never abandoned, and a tile is never clicked twice.

That reading is done from the board itself, not from what the loop remembers, so
it also covers a page reload mid-round and a round you opened by hand.

Failures back off (1.5s, 3s, 4.5s… capped at 8s) and only a run of eight in a row
with no round completing in between actually stops the bot. Press **Diagnose** to
see what it would do right now: `roundOpen`, `tilesAlreadyPicked`, and
`wouldResumeAt`.

## Keeping the Mac awake

**The app window does this — leave `TronPick Gems Autoplay.app` open.** While it
is running it holds two real power assertions, the same mechanism `caffeinate`
uses:

```
$ pmset -g assertions | grep TronPick
pid 21132(TronPick Gems Autoplay): PreventUserIdleSystemSleep  named: "TronPick Gems Autoplay is running"
pid 21132(TronPick Gems Autoplay): PreventUserIdleDisplaySleep named: "TronPick Gems Autoplay is running"
```

Quitting the app (or closing its window) releases them immediately.

The extension *also* asks for a Screen Wake Lock, but that one is unreliable on
its own: Safari grants it only to a visible tab, drops it the moment the tab is
hidden, and refuses it outright when there is no user gesture in the page — so
pressing Start from the toolbar popup rather than the on-page panel usually gets
nothing. It is a bonus, not the mechanism.

Neither approach survives closing the lid. Note also that Safari throttles timers
in background tabs, so the gems tab should stay frontmost regardless.

Pausing takes effect at the next click, so an in-flight round finishes its
current step first.

### Stats

Counters are kept in extension storage (`browser.storage.local`), written at
round boundaries rather than on every poll. They survive pausing, reloading the
page, and quitting Safari, so a session's tally keeps accumulating across all of
that. **Reset stats** is the only thing that clears them.

"Net" is the balance now minus the balance when the counters were last reset —
*not* since you pressed Start, so pausing and resuming does not zero it.

## Is the middle tile a bad place to sit?

The board is turned over at the end of every round, which is enough to check the
game rather than just play it. With **Record every revealed board** ticked, each
finished round is stored and the popup's **Tile report** turns the pile into an
answer:

```
Rounds recorded  1204
Untouched rows   4239
Tiles revealed   bomb 36, cashout 1, of 36
gem  = img:gem.png
bomb = img:bomb.png

Bomb rate by column, rows we never touched
 L 33.2%  M 33.4%  R 33.4%
 n=12717  chi2=0.05  p=0.975

Bomb on our tile 385/1204 = 32.0%
  untouched rows 33.4%
  z=-0.98  p=0.327
We clicked  L 0  M 1204  R 0
Live call vs board  1204 ok, 0 wrong
```

Two questions, because a game can be crooked in more than one way:

- **Bomb rate by column** — are bombs spread evenly across the three columns at
  all? A chi-square against "one column in three" with two degrees of freedom.
- **Bomb on our tile** — how often the tile under the cursor was the bomb,
  against the per-tile bomb rate on the rows nobody touched. This is the one
  that would catch a board reacting to the click.

Only rows we never picked from are counted, and that restriction is the whole
reason the figures mean anything. A row we did pick from is fully revealed
exactly when the tile we took was the bomb — that is what ended the round — so
its bomb sits in our column by definition. Counting those rows would report the
middle column as 100% bombs on a perfectly fair board. They are set aside and
answered for separately, by the second question.

A verdict is printed underneath in plain words, and it refuses to commit until a
few hundred rounds are in. **Copy data** puts what the browser is still holding
on the clipboard; **Clear boards** empties that buffer and leaves the collector's
file alone, since that file is the record.

### Collecting the rounds

The analysis does not run in the browser. The extension records what it sees and
sends it on; the naming of the pictures and every figure above is worked out by
a collector on your own machine, over the whole history.

```
./server/setup-cert.sh      # once, see below
node server/collect.js      # collect on :8765 into server/rounds.jsonl
node server/report.js       # print the report from that file
open https://localhost:8765 # the same report, refreshing itself every 5s
```

It is served over **https**, and that is not decoration. The game is served over
https, and a page served over https may not open a plain-http connection — the
browser refuses it before the request is made, and reports it exactly as it
reports a server that is not running. `setup-cert.sh` makes a self-signed
certificate for `localhost` and adds it to your login keychain as trusted, which
removes the rule rather than arguing with it. No admin password; macOS asks for
permission, and the script's header has the one-line command to undo it.

A batch of 50 finished rounds goes out at a time, won and lost alike, in the
order they were played — which tile of a row was the bomb only means anything
alongside how the round ended, so a history with the losses left out could not
name a bomb at all. Rounds not yet acknowledged are also sent when you press
Pause, when the page loads, and from **Export now** in the popup.

Nothing leaves the machine: `localhost` is your Mac talking to itself. Four
routes are tried in turn — the extension's background worker and the page
itself, over https and then http — and the panel names each one it could not
use, so a failure says which wall it hit rather than just that it failed.

**If the collector is not running, nothing is lost.** Rounds are held in the
browser and re-sent later — a batch is only marked sent once the collector says
it stored it. Each round is filed under its session and number, so a batch that
arrives twice is recognised and dropped rather than counted twice. The panel
shows `holding 37` instead of a hit rate while that is going on. Only if the
collector stays down for about three thousand rounds do the oldest start falling
out of the browser's buffer, and it says so in the log when that happens.

The file is append-only, one JSON object per line, holding each cell's signature
rather than a verdict about it. That is what makes the interpretation cheap to
change: when the bomb turned out to have no picture at all, the fix was one line
in `report.js` and a re-read of the whole file — no rebuild, no reload, nothing
migrated in place, and the original evidence still there to check it against.

### How a revealed tile is read

Nothing is hard-coded about what a gem or a bomb looks like — the site could
change its artwork tomorrow.

- The **grid is captured at the start of the round**, while every tile still
  shows a multiplier and can be found by text. What is kept is the element
  behind each cell: the outermost box around a multiplier that does not also
  contain another one. That reference still works after the text is swapped for
  an icon, which is the only reason a revealed tile can be read at all.
- A tile is then described by the **picture inside it** — image filename, `<use>`
  target, SVG path data, background image, icon-font glyph — ignoring the tile's
  own classes and background, since the tile we clicked is highlighted and must
  not come out looking different from its neighbours because of it.
- **Showing nothing counts as a description.** On this board a gem is an icon
  element and a bomb is an empty span: the losing tile has no picture at all. A
  revealed tile with nothing in it is therefore recorded as its own kind rather
  than as a tile that could not be read. Skipping the tile's own classes is what
  makes that work — our bomb and an untouched one both come back blank, where
  reading the highlight would have made the one we clicked unique.
- Which picture is the bomb is **learned from our own picks**, the only tiles
  whose outcome is not in doubt: a completed cashout means every tile taken was
  a gem, a board back on START after a bomb means the last one was not. Nine
  sightings out of ten have to agree before a picture gets a name.
- That naming is redone from the whole log every time the report is drawn, so
  boards recorded before the bot knew what a bomb looked like still count.
- Rounds that reveal only part of the board are **still recorded**, for whatever
  they do show. *Tiles revealed* in the report says how much each ending turns
  over, which is the first line to look at if the report stays empty.

Because the label comes from the round's real outcome rather than from the
gem-or-bomb call made mid-play, the two can be compared: **Live call vs board**
counts how often the judgement made during the round matched the board that was
actually revealed. A disagreement there means the Won / Lost counter is drifting
and the report says so.

Recording costs a fraction of a second per round. The wait adapts: after five
rounds of each kind it knows how many tiles a cashout and a bomb each turn over,
and stops looking as soon as it has that many.

Both endings turn the whole board over, so every round contributes its nine
untouched rows and a few hundred rounds is enough to read the report.

## How elements are found

The page's markup was not available when this was written (the game is behind a
login), so nothing depends on class names or IDs. Instead:

- **Tiles** are the on-screen elements whose text is an `x1.46`-style multiplier.
  A tile that has been picked shows an icon instead and drops out of that set,
  which is deliberate: the row about to be clicked always still has all three
  intact, so targeting never depends on recognising a revealed tile.
- **Rows** are grouped by vertical screen position and sorted bottom-up, so row
  0 is the bottom row regardless of DOM order.
- The **middle tile** is the one nearest the middle-column centre, taken as the
  median across every full row — so a row that has already lost its middle tile
  cannot throw the aim off.
- **START / CASHOUT** is the largest visible element whose text is exactly that
  word; its label is what tells the bot whether a round is open.
- The **bet field** is picked by ranking the number boxes: one the page labels
  *bet*, *stake* or *wager* wins, and being typeable counts for something. It has
  to be a ranking rather than a filter, because the site disables the bet box
  while a round is open. Getting this wrong is silent — taking the first number
  on the page found the payout beside it, which holds bet × the row multiplier,
  so every stake the loop set went into a box the site recalculates and ignores
  and the bet never actually changed. Diagnose names the field it picked and the
  words around it.
- **Gem vs bomb** is read from the clicked row losing a tile while the round is
  still open. A settle delay after the reveal avoids being fooled by the flip
  animation on a bomb.
- If a click produces no change within 2.5s it is retried (up to 3 times) rather
  than waiting out the timeout — the board is sometimes still animating.

If the site changes and something stops being found, press **Diagnose** in the
popup while a round is open — it dumps what the bot currently detects: button
label, row count, the tiles in each of the bottom rows, which input it takes for
the bet and what sits next to it, the balance, and what the recorder has made of
the last dozen rounds.

If the popup itself says nothing at all while the panel on the page is working,
they belong to different installed copies of the extension. Safari grants each
copy its own access to a site, and a popup belonging to a copy that has not been
granted `tronpick.io` talks to nobody. Turn the duplicate off — `build.sh`
deletes the unembedded copy of the extension that the build leaves beside the
app, which is what registers a second entry.

## Editing

Edit files in `extension/`, then re-run `./build.sh run`. `build.sh` regenerates
the Xcode project if it is missing and fixes up the bundle identifiers, which the
converter otherwise emits mismatched.

```
extension/manifest.json   MV3 manifest, scoped to gems.php only
extension/content.js      detection + the play loop + board recorder + panel
extension/background.js   sends batches to the collector
extension/popup.html/.js  toolbar UI
server/collect.js         receives rounds, appends rounds.jsonl
server/report.js          the statistics; also `node server/report.js`
server/store.js           the append-only file
server/setup-cert.sh      certificate for localhost, trusted once
build.sh                  sync -> xcodebuild
xcode/                    generated Safari app wrapper
```

## Caveats

- Automating play is very likely against tronpick's terms of service. Using this
  risks the account.
- It does not change the odds. A round has exactly the same expected value
  automated as it does by hand — it just gets there faster, which also means
  losses accumulate faster. Set a stop-loss.
- Every setting here trades runtime, not edge. Fewer rows per round and a
  smaller bet both stretch how long a balance lasts; neither makes it grow.
- The tile report asks whether one column is treated differently from another.
  It cannot find a way to win: an evenly spread board still pays x1.46 on a
  two-in-three shot, which *is* the 2.7% edge. A clean report means switching
  columns is pointless, not that the game is worth playing.
- Safari drops *Allow Unsigned Extensions* on every quit; re-tick it, or sign the
  app with a Developer ID to make it stick.
- If **Gems Autoplay** appears twice in *Safari › Settings › Extensions*, turn one
  off. Two enabled copies put two content scripts on the page and only one can
  own it; the other stands down and its popup will tell you so. `build.sh` now
  deletes the unembedded copy of the extension that the build leaves beside the
  app, which is what registers the second entry.
