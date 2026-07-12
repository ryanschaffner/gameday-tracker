# Game Day Tracker ⚽

A simple, installable web app for tracking a kids' soccer team on game day: roster, formations, substitutions, playing time, and a live clock — all in one page, no login required.

**Live app:** https://ryanschaffner.github.io/gameday-tracker/

## What it does

- **Roster** — add players, tag goalkeepers, assign jersey numbers, and jot a free-text note per player (e.g. "strong CB, keep off ST") that surfaces as a hint when you're picking who fills a position.
- **Lineups** — build each quarter's formation with drag-and-drop, choose from 4 preset 8v8 formations (3-3-1, 2-3-2, 3-2-2, 3-1-2-1), plus fallback formations for 7v7 (2-3-1, 3-2-1) and 6v6 (2-2-1, 1-3-1) games. If fewer than 8 players are checked in as present, an empty quarter automatically switches to the best-fit formation for however many showed up — no manual setup needed on a short-roster game day. **Rotate areas** shifts everyone currently in the lineup between defense/midfield/forward (and goal, if no keeper is explicitly set) — built for squads with exactly enough players and no bench to sub from, and works the same way at any squad size.
- **Quarter clock** — a 12-minute start/pause/reset countdown per quarter. Sub times default to whatever the clock reads when you log them, instead of guessing the minute by hand.
- **Substitutions** — individual subs, "sub the whole bench" at once, and a "suggest subs" helper. Tap a player on the field to flag them **tired** — flagged players are always brought off first; if nobody's flagged, it falls back to whoever's been on the field longest without a break (goalie time doesn't count against them). The flag clears automatically once that player's actually subbed off.
- **Sub-timing alert** — while a quarter's clock is running, a banner pops up naming any player who's been on the field past a set number of consecutive minutes (default 6, adjustable on the Roster tab), so you don't have to keep glancing at the clock. If nobody's individually over yet, you still get a generic "5 minutes gone, worth a check" nudge. Tap Dismiss to clear it, or Suggest Subs to act on it right away.
- **Injured / Out for today** — on a present player, the check-in list's action button becomes **Injured/Out** once they've logged any minutes that game (still just **Out** if they haven't played yet, for correcting a mis-tap). Marking someone Injured/Out drops them from the pool for future quarters, keepers, and subs, but keeps every minute they already played intact in the minutes table, email summary, and season stats — nothing about the game so far gets erased. A **Reactivate** button on the "Injured / out for today" list brings them back if it turns out they're fine to keep playing.
- **Fair playing time** — tracks each player's minutes live and flags who's short or over target, with a one-tap "auto-plan" that balances a whole game while keeping goalkeepers from playing the entire match. Targets adjust automatically to however many players are actually on the field for the day's formation.
- **Goals & game summary** — log goals as they happen, then send a postgame summary by email (plain text, works in any mail app) or **copy formatted** (a real table with color-coded status, for pasting into a rich email draft).
- **Season tracking** — the Season tab automatically totals minutes, minutes-by-position, and goals/assists across every game logged, including an avg-minutes/game column so fairness is visible even when someone's missed a game. A separate "Send season summary" option (email / copy / copy formatted) is available on that tab — season totals are never bundled into a per-game email automatically.
- **Backup** — export/import your data as a JSON file at any time from the Backup tab.

## How it works

The app is two files: `index.html` (all the app logic, styling, and markup) and `sw.js` (a small service worker). There's no build step, no server, and no framework. All data is stored in your browser's local storage on whatever device you're using it from.

`sw.js` is what makes the app reliably usable with no signal at the field — it caches the page the first time you load it online, and serves that cache if the network's unavailable. Without it, "installed" would just mean an icon on your home screen with no real offline guarantee.

**Important:** because everything is stored locally in the browser, data does **not** sync across devices or between coaches. Use the Backup tab's Export button regularly if you want a copy, and before switching phones or browsers. Multi-device sync and sharing with a co-coach is a real possibility for later, but would need a backend and accounts — a bigger project than what's here today.

## Making changes

To edit the app, edit `index.html` (and `sw.js` if you're touching offline behavior) directly in this repo and commit. GitHub Pages automatically republishes the site within a minute or two of any push to the `main` branch. Both files need to live at the repo root for the service worker registration to find `sw.js`.

After any deploy, it's worth doing a quick real-device check: load the app once with normal signal, then switch to airplane mode and reopen it — it should still work.

## Hosting

This site is hosted for free with [GitHub Pages](https://pages.github.com/), configured in this repo's Settings → Pages to build from the `main` branch root.
