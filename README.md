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

Requires Xcode (already used to produce the project under `xcode/`).

```bash
./build.sh run
```

`build.sh` syncs `extension/` into the Xcode target, builds a Release app, and
opens it so Safari registers the extension. Then, in Safari:

1. **Settings → Advanced →** tick *Show features for web developers*
2. **Develop → Allow Unsigned Extensions**  — the build is ad-hoc signed, so this
   is required, and it resets every time Safari quits
3. **Settings → Extensions →** enable *TronPick Gems Autoplay*
4. Give it permission on `tronpick.io` (choose *Always Allow on This Website*)

Reload `https://tronpick.io/gems.php`.

> If **Gems Autoplay** appears twice in the Extensions panel, turn one off. Two
> enabled copies put two content scripts on the page and only one can own it; the
> other stands down and its popup will tell you so. Note also that turning an
> extension off and on again **clears its storage** — the counters go with it.

## Use

Two equivalent controls:

- The **panel on the page**, bottom-right: rounds, won/lost, bet, balance, net,
  Start/Pause, and a `☰` button that expands a running log.
- The **toolbar popup**, which adds the settings, **Reset stats**, and
  **Diagnose** — what the page looks like right now: the button, the rows, which
  input it takes for the bet, and the balance.

### Settings

| Field | Meaning |
| --- | --- |
| Bet amount | Typed into the page's bet field before each round. Blank = `0.02`. |
| Below balance / …bet this instead | Step the stake down once the balance drops under the threshold, e.g. `0.5` and `0.01`. It steps back up if the balance recovers. |
| Stop below balance | Halt once the wallet balance falls to or under this. |
| Take profit / Stop loss | Halt once net profit/loss for the session crosses this. Blank = off. |
| Max rounds | Halt after this many rounds. Blank = unlimited. |
| Delay between rounds | Milliseconds of pause after each round. |

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

### Losing the connection

The bot stands down the moment the machine goes offline and picks up again when
it comes back. Without that, clicks land on a page that cannot answer, the loop
spends its eight recoveries finding that out, and a round with a live stake can
be left open while that plays out. An open round is not abandoned: on resuming,
the board is read fresh and play continues from whatever state it is in, exactly
as after a reload.

Any *deliberate* stop cancels the resume — Pause, a stop-loss, running out of
funds. Coming back online is not a reason to overrule those. Pressing **Start**
with no connection arms it rather than refusing, and it begins when the network
returns.

`navigator.onLine` only says the machine has a network interface up: Wi-Fi
attached to a router with no internet still reads as online, and this will not
notice. What catches that is the game failing to respond, which the recovery
above already handles.

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
- The **balance** is the top-most standalone decimal *on screen*. An `<option>`
  counts only if it is the selected one, and only when nothing visible was
  found: the currency picker holds an option per coin, each with its own number,
  and an unselected one is a different wallet. Reading one of those showed a
  balance of 0.0092 against a real 11.29 and stopped the session for running out
  of funds it had plenty of.
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
extension/content.js      detection + the play loop + on-page panel
extension/popup.html/.js  toolbar UI
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
- Whether the board is biased was measured and it is not. Over 2341 rows nobody
  had touched, the bomb landed on the left, middle and right columns 33.5%, 34.2%
  and 32.3% of the time (chi-square p=0.53), and the tile we clicked bombed no
  more often than the ones we never touched. That was the expected answer and it
  is not good news: an evenly spread board still pays x1.46 on a two-in-three
  shot, which *is* the 2.7% edge. There was nothing to find, so the code that
  looked for it has been removed.
- Safari drops *Allow Unsigned Extensions* on every quit; re-tick it, or sign the
  app with a Developer ID to make it stick.
- If **Gems Autoplay** appears twice in *Safari › Settings › Extensions*, turn one
  off. Two enabled copies put two content scripts on the page and only one can
  own it; the other stands down and its popup will tell you so. `build.sh` now
  deletes the unembedded copy of the extension that the build leaves beside the
  app, which is what registers the second entry.
