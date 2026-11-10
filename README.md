<p align="center"><img src="docs/brand/corgi-logo-256.png" width="180" alt="Corgi" /></p>

<h3 align="center">Five Herdr mods that work alone and click together when you install more than one</h3>

<p align="center">Corgi is a small set of mods for the <a href="https://herdr.dev">Herdr app</a>: a ⌘⇧P box that finds what you already have open, a pull request review, a chat bar for agents that wait on you, a work time tracker and dictation. Each one lives in its own repo and works without the others. Install two and they find each other on their own. The <code>corgi</code> command installs any of them, keeps your own edits through updates, and can roll back.</p>

<p align="center"><img src="docs/previews/goto.png" width="88%" alt="Go to: a search box over Herdr that found an agent by a few words of its task" /></p>

<p align="center"><sub>✓&nbsp;Free,&nbsp;MIT&nbsp;licensed &nbsp; ✓&nbsp;Runs&nbsp;locally &nbsp; ✓&nbsp;herdr-app&nbsp;0.1.14+</sub></p>

<br />

## Install in three steps

<table>
<tr>
<td align="center" valign="top" width="33%"><h3>1</h3><b>Clone this repo</b><br /><sub><code>git clone https://github.com/saefty/herdr-corgi</code>, then <code>cd herdr-corgi</code>. You need Python 3 and git.</sub></td>
<td align="center" valign="top" width="33%"><h3>2</h3><b>Enable the mods</b><br /><sub><code>./corgi.py enable --all --dry-run</code> shows what it would do. <code>./corgi.py enable --all</code> does it, or name the mods you want: <code>./corgi.py enable goto chatbar</code>.</sub></td>
<td align="center" valign="top" width="33%"><h3>3</h3><b>Restart nothing</b><br /><sub>Herdr reloads mods as soon as their files appear. Some need a key or a block in your layout; each mod's README says which.</sub></td>
</tr>
</table>

`enable` asks before it adds shortcuts to your `keys.json`. With `--all` it never touches `keys.json` unless you add
`--keys=merge`; otherwise it prints the shortcuts for you to add by hand. A key you already use is never rebound.

## The mods

### Go to

A ⌘⇧P box that finds what is already open before it opens anything new: agents by a few words of their task, spaces,
repos, pull requests, URLs and Herdr's own commands. The other mods add their rows to it.
[herdr-corgi-goto](https://github.com/saefty/herdr-corgi-goto)

### PR review

A side panel with the focused branch's diff and a full review layout: an AI walkthrough by risk and layer, reviewer
agents whose findings you send back to the agent that wrote the code, and comments posted as one GitHub review.
[herdr-corgi-pr-review](https://github.com/saefty/herdr-corgi-pr-review)

<p align="center"><img src="docs/previews/pr-review.png" width="88%" alt="The review layout's overview of a demo pull request" /></p>

### Chat bar

One bubble per agent that waits on you, in the corner of every layout. Read the question, press an option or type a
reply, and stay where you are. [herdr-corgi-chatbar](https://github.com/saefty/herdr-corgi-chatbar)

<p align="center"><img src="docs/previews/chatbar.png" width="88%" alt="The chat bar with an agent asking for permission" /></p>

### Time tracker

A chip that counts your work time today while you are at the keyboard, in Herdr, in your work apps or while your
agents run. Every day lands in an Excel workbook. [herdr-corgi-timetrack](https://github.com/saefty/herdr-corgi-timetrack)

<p align="center"><img src="docs/previews/timetrack.png" width="60%" alt="The time tracker's popup with today's timeline" /></p>

### Dictate

Press a key, speak, press it again: the text is transcribed on your Mac and lands where your cursor is, never sent.
macOS on Apple Silicon. [herdr-corgi-dictate](https://github.com/saefty/herdr-corgi-dictate)

## Better together

Each mod works on its own. Install more than one and they start helping each other:

- **Go to + PR review:** paste any PR link into Go to and pick "Review PR". Reviews you started show up there too,
  so you can jump back in.
- **Go to + Chat bar:** agents waiting on you show up in Go to. Press Enter to answer in their chat bubble.
- **PR review + Chat bar:** "Discuss in chat" on a finding opens the agent's bubble, so you follow its answer
  without leaving the review.
- **Chat bar + Dictate:** a mic in every bubble. Say your reply and edit it before you send it.
- **Separate setups, like work and personal:** one small mod of your own tells all of them which space belongs
  where. Go to switches before it jumps, the chat bar tags each agent, and the time tracker counts only work.

Remove a mod and the rest keep working. If you write mods yourself, [CONVENTIONS.md](CONVENTIONS.md) shows how to
plug into the same places.

## Let your agent install it

Give it this, in a Herdr terminal:

```text
Read ~/.config/herdr-app/AGENTS.md, clone https://github.com/saefty/herdr-corgi, read its README, run ./corgi.py enable --all --dry-run, show me the result, and run it for real after I say yes.
```

## Install as a layout

Want the whole window at once? The Corgi layout puts Herdr's sidebar and tab bar together with the time chip in the
tab row, the PR panel on the right, and the chat bar and dictation over your terminals.

<p align="center"><img src="preview.png" width="88%" alt="The Corgi layout with a demo PR, a working agent and a chat bubble" /></p>

Give your agent this, in a Herdr terminal:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this layout: https://github.com/saefty/herdr-corgi/tree/main
```

It copies `layouts/corgi.json` and the folders in `mods/`, merges `keys.json` (⌘⇧P Go to, ⌘⇧M dictate, ⌘⇧B the PR
column) and switches to the layout. `ctrl-shift-l` switches back to yours. The mods in `mods/` are copies of each
mod's latest release; to get updates later, clone this repo and run `./corgi.py enable --all`.
[RECIPE.md](RECIPE.md) describes the layout piece by piece.

## Updates

```bash
./corgi.py status            # installed versions, available updates, files you changed
./corgi.py update            # every mod to its latest release, with the changelog
./corgi.py update goto@1.2.0 # one mod to one version
./corgi.py rollback goto     # back to the version before
```

Nothing updates by itself. An update shows what changed, applies it, then runs `herdr-app check` on the mod; if the
check fails, that mod goes back to its previous files.

Your own edits survive. corgi keeps a clean copy of every version it installed. A file only you changed is kept, a
file only the release changed is replaced, and a file you both changed is merged. If the merge has a conflict, the
whole mod stays on its old version and you choose: `./corgi.py resolve <mod>` opens an agent tab that re-applies your
changes to the new version for you to review, `--keep-mine <file>` keeps yours, or `--take-theirs <file>` takes the
release and saves yours as a patch. `./corgi.py diff <mod>` shows what you changed.

**Update notices inside Herdr.** The `corgi` mod checks once a day and posts one notification when new releases are
out. Click it for the changelog and an Update button that runs `corgi.py update` in a new tab, so you see every step.
It needs a floating block in each layout you use (`~/.config/herdr-app/layouts/<name>.json`, on the root node); the
block draws nothing:

```json
"floating": [ { "id": "corgi", "content": { "mod": "corgi" }, "edge": "bottom", "align": "end" } ]
```

To open it any time, bind a key to `mod.open {"name": "corgi"}`.

## Develop a mod

The mod's git checkout is the source; you edit the live folder in `~/.config/herdr-app/mods/<mod>`, where Herdr
reloads it on every save.

```bash
./corgi.py dev goto ~/code/herdr-corgi-goto   # link the live folder to your checkout
./corgi.py save goto "fix(goto): rank exact titles first"   # copy live to checkout and commit
./corgi.py release goto minor                 # tests, leak check, herdr-app check, changelog, tag, push
```

`save` refuses when the checkout has other uncommitted changes and never copies the files Herdr generates.
`release` writes the changelog from your Conventional Commits, shows a summary and asks before it pushes.
`./corgi.py sync` installs everything in your `corgi.lock`, which is how you restore a setup on a new machine.
Each repo's CI runs its tests and a leak check on every push; `herdr-app check` needs Herdr's window, so it runs
on your machine before every release.

## License

[MIT](LICENSE)
