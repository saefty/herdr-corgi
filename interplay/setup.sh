#!/bin/sh
# Builds the interplay demo in interplay/run (recreated on every run, ignored by git). Nothing here starts Herdr;
# run.py does, installs the mods and runs the checks.
#   run/user  a stand-in home: ~/code holds invented clones (acme/bookshelf with PR #7 and a local stand-in for its
#             GitHub remote, acme/orbit-sync, acme/ledger); herdr-core's config gives the demo its own core
#             (socket /tmp/corgi-demo/core.sock: socket paths must be short); demo shells get the stand-in programs
#             (gh, claude, ffmpeg, parakeet-mlx) first on PATH
#   run/app   a Herdr home: settings, the interplay and review layouts, the mods' configs, the demo-only interplay
#             mod, and pr-review's caches seeded with the invented PR (its own demo/seed.mjs)
# The mod checkouts are the siblings of this repo (../herdr-corgi-<mod>); CORGI_SRC picks another folder.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
src=${CORGI_SRC:-$(dirname "$root")}
run="$here/run" user="$here/run/user" app="$here/run/app" fx="$here/fixtures"
goto_demo="$src/herdr-corgi-goto/demo" pr_demo="$src/herdr-corgi-pr-review/demo"
for d in "$goto_demo/fixtures" "$pr_demo/fixtures" "$src/herdr-corgi-pr-review/mods/pr-review"; do
  [ -d "$d" ] || { echo "missing $d (set CORGI_SRC to the folder with the herdr-corgi-<mod> checkouts)" >&2; exit 1; }
done
core=$(command -v herdr-core || command -v hc)
py=$(command -v python3)
if HERDR_APP_HOME="$app" herdr-app status > /dev/null 2>&1 || [ -S /tmp/corgi-demo/core.sock ]; then
  echo "a demo seems to be running: run 'python3 interplay/run.py --stop' first" >&2; exit 1
fi
rm -rf "$run"
mkdir -p "$user/.config/herdr-core" "$user/code" "$user/Documents/Timesheets" "$run/bin" "$run/tmp" \
  "$app/mods" "$app/layouts" "$app/control" "$app/interplay-log" /tmp/corgi-demo

# The demo's own herdr-core and shell: stand-ins first on PATH, its own temp folder (dictate keeps its recording
# state there), the stand-in transcriber for dictate's worker.
printf 'socket = "/tmp/corgi-demo/core.sock"\nshell = ["/bin/zsh"]\n' > "$user/.config/herdr-core/config.toml"
cat > "$user/.zprofile" <<EOF
export PATH="$run/bin:$fx/bin:\$PATH"
export PYTHONPATH="$fx/py"
export TMPDIR="$run/tmp"
unset TIMETRACK_DATA
EOF
printf "PROMPT='%%F{cyan}%%~%%f %%# '\n" > "$user/.zshrc"
# dictate runs parakeet-mlx's worker with the python its launcher names: this one, with the stand-in on PYTHONPATH.
printf '#!%s\n# A stand-in parakeet-mlx launcher: only its first line is read (dictate takes the python from it).\n' "$py" > "$run/bin/parakeet-mlx"
chmod +x "$run/bin/parakeet-mlx" "$fx/bin/ffmpeg"

repo() { # name, branch
  d="$user/code/$1"
  git init -q -b main "$d"
  git -C "$d" config user.name "Demo"; git -C "$d" config user.email "noreply@example.com"
  printf '# %s\n' "$1" > "$d/README.md"
  git -C "$d" add -A
  GIT_COMMITTER_DATE="2026-10-01T10:00:00Z" git -C "$d" commit -q --date "2026-10-01T10:00:00Z" -m "chore: start $1"
  git -C "$d" remote add origin "git@github.com:acme/$1.git"
  [ -z "${2:-}" ] || git -C "$d" checkout -q -b "$2"
}
repo orbit-sync fix/login-redirect
repo ledger

# acme/bookshelf with PR #7, as pr-review's demo/setup.sh builds it (its fixtures, its dates).
b="$user/code/bookshelf"
git init -q -b main "$b"
git -C "$b" config user.name "Demo"; git -C "$b" config user.email "noreply@example.com"
cp -R "$pr_demo/fixtures/repo/base/." "$b"
git -C "$b" add -A; GIT_COMMITTER_DATE="2026-03-01T10:00:00Z" git -C "$b" commit -q --date "2026-03-01T10:00:00Z" -m "chore: loans and mail"
git -C "$b" checkout -q -b feat/due-reminders
cp -R "$pr_demo/fixtures/repo/head/." "$b"
git -C "$b" add -A; GIT_COMMITTER_DATE="2026-03-09T16:30:00Z" git -C "$b" commit -q --date "2026-03-09T16:30:00Z" -m "feat(loans): add due-date reminders"
head=$(git -C "$b" rev-parse HEAD)
remote="$user/remotes/github.com/acme/bookshelf.git"
git clone -q --bare "$b" "$remote"
git -C "$remote" update-ref refs/pull/7/head "$head"
git -C "$b" remote add origin "$remote"
git -C "$b" fetch -q origin
git -C "$b" remote set-head origin main
# What the stand-in gh answers for PR #7.
printf '{"url":"https://github.com/acme/bookshelf/pull/7","number":7,"title":"feat(loans): add due-date reminders","author":{"login":"ada"},"state":"OPEN","isDraft":false,"headRefName":"feat/due-reminders","headRefOid":"%s","baseRefName":"main","updatedAt":"2026-11-10T09:00:00Z","reviewDecision":"REVIEW_REQUIRED","additions":55,"deletions":0}\n' "$head" > "$run/gh-pr7.json"

# The Herdr home.
cp -R "$fx/interplay" "$app/mods/"
cp "$fx/layouts/interplay.json" "$app/layouts/"
# The review layout as pr-review installs it on first use, with the chat bar, dictation and the interplay mod in it.
"$py" - "$src/herdr-corgi-pr-review/mods/pr-review/review-layout.json" "$app/layouts/review.json" <<'EOF'
import json, sys
l = json.load(open(sys.argv[1]))
l["children"].append({"id": "interplay", "type": "block", "size": {"px": 0}, "content": {"mod": "interplay"}})
l["floating"] = [{"id": "chatbar", "content": {"mod": "chatbar"}, "edge": "bottom", "align": "end"},
                 {"id": "dictate", "content": {"mod": "dictate"}, "edge": "bottom", "align": "center"}]
json.dump(l, open(sys.argv[2], "w"), indent=1)
EOF
printf '{ "appearance": "dark", "telemetry": false, "sounds": { "enabled": false }, "core": "%s" }\n' "$core" > "$app/settings.json"
# Mostly off screen, so your mouse doesn't hover rows in the shots; skip the "Updated" pill.
printf '{ "state": "windowed", "bounds": [1800.0, 900.0, 1280.0, 760.0] }\n' > "$app/window.json"
printf '{ "last_run": "%s", "presented": [] }\n' "$(herdr-app --version | grep -o '[0-9][0-9.]*' | head -1)" > "$app/update-notes.json"
printf '{ "roots": ["~/code"], "depth": 2 }\n' > "$app/goto.config.json"
printf '{ "cloneRoot": "%s", "language": "English", "dryRun": true }\n' "$user/code" > "$app/pr-review.config.json"
printf '{ "excel_dir": "%s" }\n' "$user/Documents/Timesheets" > "$app/timetrack.config.json"
printf '{ "maxSeconds": 30 }\n' > "$app/dictate.config.json"

# pr-review's caches for PR #7, from its demo fixtures (seed.mjs imports pr.js from <home>/mods/pr-review).
mkdir -p "$run/seed/mods"
ln -s "$src/herdr-corgi-pr-review/mods/pr-review" "$run/seed/mods/pr-review"
node "$pr_demo/seed.mjs" "$run/seed" "$b" "$head" > /dev/null
cp -R "$run/seed/pr-data" "$app/"
# Its shared state, plus: no welcome tour, "← Back" returns to the interplay layout.
"$py" - "$run/seed/shared.json" "$app/shared.json" <<'EOF'
import json, sys
s = json.load(open(sys.argv[1]))
s.update({"frame.welcomed": "skipped", "review.back": "interplay"})
json.dump(s, open(sys.argv[2], "w"), indent=1)
EOF
echo "demo ready: $run"
