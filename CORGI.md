# corgi usage

`corgi.py` installs, updates and develops the herdr-corgi mods. It is one Python 3 file with no dependencies.
Run it from a clone of this repo (`./corgi.py …`) or symlink it into `~/.local/bin/corgi`.
Every command that changes something accepts `--dry-run`.

## Install and remove

```sh
corgi enable goto chatbar      # install mods; asks before adding their shortcuts to keys.json
corgi enable --all             # every default mod in mods.json; shortcuts only with --keys=merge
corgi disable goto             # removes only unchanged files, and keys that still have corgi's value
corgi status [--json]          # versions, available updates (with changelog), files you changed
corgi doctor                   # herdr-app, git, gh, python3, each mod's requires
```

A mod folder that already exists is adopted: corgi compares it with the release, reports the files that differ and
leaves them alone. It never overwrites a file you changed.

## Updates

```sh
corgi update [mod[@X.Y.Z]]     # shows the changelog, applies, runs herdr-app check, rolls back if it fails
corgi rollback goto            # back to the previous version in the lock history
corgi diff goto                # your changes against the installed version
```

On update, each file is either replaced (only upstream changed), kept (only you changed it) or three-way merged
(both changed). If any file conflicts, the mod stays on its old version and corgi offers:

```sh
corgi resolve goto             # opens a Claude tab in Herdr that re-applies your changes to the new version
corgi resolve goto --apply     # afterwards: shows the diff, asks, applies, runs check
corgi update goto --keep-mine lib/x.js
corgi update goto --take-theirs lib/x.js   # your version is saved as a patch under backups/
```

`corgi customizations export` writes your changes to `customizations/<mod>.patch` in the Herdr config folder, and
`corgi sync` re-applies them after a fresh install.

## A new machine

`corgi.lock` in the Herdr config folder records each mod, its version and its dev checkout. `corgi sync` installs
everything in it (and clones missing dev checkouts). Add `--keys=merge` to merge shortcuts too.

## Authors

```sh
corgi dev goto ~/src/herdr-corgi-goto   # the checkout is the mod's source; adds a pre-push leak check
corgi save goto "feat: fuzzy titles"    # copies the live folder into the checkout and commits
corgi release goto minor                # checks, changelog from commits, bump, tag; asks before pushing
```

```sh
corgi bundle                            # copies each released mod into mods/<mod>/ for the herdr.dev layout
```

`bundle` takes each mod in `mods.json` (not corgi itself) at its latest `vX.Y.Z` tag, or the default branch with a
warning, writes `mods/<mod>/BUNDLED.md` and `bundle.json` (`{mod: {repo, tag, sha}}`). CI's
`.github/scripts/check_bundle.py` fails when a copy no longer matches its recorded tag. Edit the mod repos, then
re-bundle.

`save` refuses a checkout with uncommitted changes and skips generated files (`gpui-kit.d.ts`, `jsconfig.json`)
and anything listed in the mod folder's `.corgi-private`. `release` runs the repo's `.github/scripts/check.py`,
`herdr-app check` on the live folder and the private leak scan (`corgi.leaks` in the Herdr config folder, one
regex per line).

## Files

| File | What |
|---|---|
| `mods.json` (this repo) | `{"mods": {name: {"repo", "path", "default"}}}` |
| `mods/<name>/corgi.json` (mod repo) | `version`, `requires`, `provides`, `keys` (snippet path from the repo root) |
| `~/.config/herdr-app/corgi.lock` | `{name: {version, repo, dev, history}}` |
| `~/.local/share/corgi/installed.json` | `{name: {version, source, files: {path: sha256}, keys}}` |
| `~/.local/share/corgi/pristine/<mod>/<version>/` | each installed version as released, the merge base |

Overrides: `HERDR_APP_HOME`, `CORGI_HOME`, `CORGI_MANIFEST`, `CORGI_CHECK` (check command),
`CORGI_HERDR_APP` (the `herdr-app` binary), `CORGI_HERDR_VERSION`.

Tests: `python3 -m unittest discover tests`.
