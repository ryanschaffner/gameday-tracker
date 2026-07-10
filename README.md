# Game Day Tracker ⚽

A simple, installable web app for tracking a kids' soccer team on game day: roster, formations, substitutions, and fair playing time — all in one page, no login required.

**Live app:** https://ryanschaffner.github.io/gameday-tracker/

## What it does

- **Roster** — add players, tag goalkeepers, assign jersey numbers.
- **Lineups** — build each quarter's formation with drag-and-drop, choose from 4 preset formations (3-3-1, 2-3-2, 3-2-2, 3-1-2-1).
- **Substitutions** — swap players mid-quarter, with mass-sub and suggested-sub helpers.
- **Fair playing time** — automatically tracks each player's minutes and flags who's short or over their target, with a one-tap "auto-rotate" that balances a whole game while keeping goalkeepers from playing the entire match.
- **Goals & summary** — log goals as they happen, then get a shareable game summary and season view.
- **Backup** — export/import your data as a JSON file at any time from the Backup tab.

## How it works

This is a single self-contained HTML file (`index.html`) — no build step, no server, no framework. All data is stored in your browser's local storage on whatever device you're using it from, so it works offline once loaded and can be "installed" to your phone's home screen like a native app (Add to Home Screen in Safari/Chrome).

**Important:** because everything is stored locally in the browser, data does **not** sync across devices. Use the Backup tab's Export button regularly if you want a copy, and before switching phones or browsers.

## Making changes

To edit the app, edit `index.html` directly in this repo (or clone it locally) and commit. GitHub Pages will automatically republish the site within a minute or two of any push to the `main` branch.

## Hosting

This site is hosted for free with [GitHub Pages](https://pages.github.com/), configured in this repo's Settings → Pages to build from the `main` branch root.
