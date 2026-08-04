# TronPick Gems Autoplay

A Safari web extension that plays the gems tower on `https://tronpick.io/gems.php`
automatically.

## The strategy

Fixed, exactly as specified:

1. Click **START**
2. Click the **middle tile of the bottom row** (x1.46 on Easy)
3. If it is a gem, click the **middle tile of the next row up** (x2.12)
4. If it is a gem, click **CASHOUT**
5. Repeat

A bomb at either step ends the round, and the next round starts on its own. The
loop keeps going until you pause it or a stop condition fires.

The bet amount, difficulty, and everything else stay exactly as you left them on
the page unless you set a bet in the popup.

## Install

Requires Xcode (already used to produce the project under `xcode/`).

```bash
./build.sh run
```

That syncs `extension/` into the Xcode target, builds a Release app, and opens
it so Safari registers the extension. Then, in Safari:

1. **Settings → Advanced →** tick *Show features for web developers*
2. **Develop → Allow Unsigned Extensions**  — the build is ad-hoc signed, so this
   is required, and it resets every time Safari quits
3. **Settings → Extensions →** enable *TronPick Gems Autoplay*
4. Give it permission on `tronpick.io` (choose *Always Allow on This Website*)

Reload `https://tronpick.io/gems.php`.

## Use

Two equivalent controls:

- The **panel on the page**, bottom-right: status, counters, Start/Pause, and a
  `☰` button that expands a running log.
- The **toolbar popup**, which adds the settings and a Diagnose button.

### Settings

| Field | Meaning |
| --- | --- |
| Bet amount | Typed into the page's bet field before each round. Blank = leave whatever is already there. |
| Below balance / …bet this instead | Step the stake down once the balance drops under the threshold, e.g. `0.5` and `0.01`. It steps back up if the balance recovers. |
| Stop below balance | Halt once the wallet balance falls to or under this. |
| Take profit / Stop loss | Halt once net profit/loss for the session crosses this. Blank = off. |
| Max rounds | Halt after this many rounds. Blank = unlimited. |
| Delay between rounds | Milliseconds of pause after each round. |

It also stops on its own when the balance drops below one bet, or if START stops
opening a round — that is the "money ran out" case.

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
- **Gem vs bomb** is read from the clicked row losing a tile while the round is
  still open. A settle delay after the reveal avoids being fooled by the flip
  animation on a bomb.
- If a click produces no change within 2.5s it is retried (up to 3 times) rather
  than waiting out the timeout — the board is sometimes still animating.

If the site changes and something stops being found, press **Diagnose** in the
popup while a round is open — it dumps what the bot currently detects (button
label, row count, the tiles it sees in each of the bottom rows, bet, balance).

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
- It does not change the odds. Picking two tiles and cashing out at x2.12 has
  exactly the same expected value automated as by hand — it just gets there
  faster, which also means losses accumulate faster. Set a stop-loss.
- Safari drops *Allow Unsigned Extensions* on every quit; re-tick it, or sign the
  app with a Developer ID to make it stick.
