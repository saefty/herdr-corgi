# Interplay suite

All five mods in one demo Herdr window, every connection between them checked, then one run per missing mod.
It runs locally only: it needs Herdr's window (`herdr-app check` and the window can't run on CI).

```sh
./interplay/setup.sh             # builds interplay/run (ignored by git)
python3 interplay/run.py         # starts the demo window, installs the mods, checks, takes screenshots, stops
python3 interplay/run.py --keep  # the same, but leaves the demo window open to look around
python3 interplay/run.py --stop  # stops a kept or crashed demo and cleans up
```

It needs the mod checkouts next to this repo (`../herdr-corgi-goto`, `../herdr-corgi-pr-review`, …;
`CORGI_SRC=<folder>` picks another place) for their demo fixtures, plus git, node, python3, ffmpeg (for the crops)
and network access to clone the mod repos.

## What runs where

Nothing touches your own window, home or terminals:

- **A second Herdr window** with its own home (`run/app`, through `HERDR_APP_HOME`) and its own herdr-core
  (`HC_SESSION=corgi-demo`, socket `/tmp/corgi-demo/core.sock`), started with a stand-in `HOME` (`run/user`).
- **Invented data only**: the repos `acme/bookshelf` (with PR #7 and a local stand-in for its GitHub remote, built
  from pr-review's `demo/fixtures`), `acme/orbit-sync` and `acme/ledger`; three stand-in agents (goto's
  `demo/fixtures/agent.sh` and its screens): one working, one asking for permission, one idle; pr-review's caches
  seeded by its own `demo/seed.mjs`.
- **Stand-in programs** (`fixtures/bin`): `gh` and `claude` answer "logged in" and the one PR lookup, never the
  network; `ffmpeg` writes a second of silence instead of opening the microphone, and `fixtures/py/parakeet_mlx.py`
  "hears" a fixed sentence, so dictation runs end to end without a model.
- **Mods** go in through `install_mods()` in `run.py`: `corgi.py enable --all --keys=merge` with
  `HERDR_APP_HOME` set to the demo home and a `CORGI_HOME` under `run/`, so this also tests corgi's install path.
  Disabling and enabling in the fallback runs use `corgi.py disable` / `enable`.

The suite drives the window only through shared keys, `herdr-app do` and `herdr-app status`. Shared keys go through
the demo-only `interplay` mod (`fixtures/interplay`): it sets the keys `run.py` writes to `run/app/control/set.json`,
logs every change of the keys the mods talk through to `run/app/interplay-log/` (so requests that live only until
their receiver takes them are seen), and plays the context hook's owner (`goto.context.request`). Go to's demo hooks
(`goto.demo.query`, `goto.demo.rows`, `goto.demo.pick`) type into its box and press Enter on a row;
`pr-review.discuss:<finding>` and `chatbar.mic` are those mods' own commands.

A window other windows cover draws, and so runs its mods' render, only when it is resized. While the suite runs it
maximizes the demo window and back about twice a second (behind your windows you won't see it), and every
screenshot does the same first.

## The checks

1. All five mods load without errors.
2. Go to offers pr-review's row for a PR link ("Review PR #7", or "Resume review #7" once a review is in progress)
   and picking it lands in the review layout with that PR.
3. Go to's "Reply to …" (from the chat bar) opens the chat bubble the person had closed.
4. pr-review's "Discuss in chat" writes `chatbar.request`: a draft for the PR's agent, taken by the chat bar.
5. The chat bar's mic writes `dictate.request`; dictate records and the words come back as a draft in the bubble.
6. One `goto.context` switch moves the chat bar's tag (its Go to items carry the new context) and changes
   timetrack's counting (the facts the chip reports, run through the installed `track.py`'s own `evaluate`).
7. For each mod in turn: disable it with corgi, restart the window, and check that the others load without errors
   and fall back as their PROVIDERS.md say (no "Review PR" row without pr-review, no "Reply to" rows and Discuss's
   own agent window without the chat bar, no mic without dictate, …), then enable it again. Herdr's own error for a
   layout that still places the removed mod ("mod dictate: no mod folder") is reported apart: corgi doesn't edit
   layouts. When corgi's enable adopts a leftover folder instead of
   installing (see the report), the check fails and the suite repairs the install so the next runs see all five.

Results: the printed list, `run/report.json` and the exit code. The screenshots for the README land in
`docs/screenshots/interplay-*.png` (see `publish()` in `run.py`); the full window shots stay in `run/shots`.
