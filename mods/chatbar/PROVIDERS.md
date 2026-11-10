# Chat bar: the plug-in contract (version 1)

The rules every mod in the herdr-corgi set shares (announcing, requests, providers, the context hook,
versions) are in [CONVENTIONS.md](https://github.com/saefty/herdr-corgi/blob/main/CONVENTIONS.md). This page has
what is specific to this mod.

The chat bar works on its own. Everything here is optional: other mods talk to it through shared state only,
and the chat bar never reads another mod's files. Load order doesn't matter: the chat bar reads these keys
every time it renders, and a plug-in can write them whether or not the chat bar is installed.

The chat bar sets `chatbar.api = {version: 1}` when it starts, so a mod can check that it is there.

## 1. Open a bubble: `chatbar.request`

```js
if (shared("chatbar.api")) {
  setShared("chatbar.request", { action: "draft", terminal: "t7", text: "…", from: "mymod", at: Date.now() });
}
```

- `action`: `"open"` opens the agent's bubble. `"draft"` opens it and puts `text` in its reply field. Nothing is
  sent; the person reads it, edits it and presses Enter.
- `append`: optional, with `"draft"`: `true` adds `text` after what is already typed in the reply field (with a
  space) instead of replacing it. Dictation uses this.
- `terminal`: the agent's address. The bubble shows whatever the agent's status (also working or idle) and
  even if the agent is on screen, until the person closes it.
- `from`, `at`: optional, for your own bookkeeping.

The chat bar takes the request on its next render and sets the key back to `null`, so the same request can be
sent again. One request at a time: a second write before the first is taken replaces it.

## 2. Agent info: `chatbar.agents.<provider>`

Register your provider name once, then publish fields per terminal address:

```js
const p = shared("chatbar.providers") ?? [];
if (!p.includes("mymod")) setShared("chatbar.providers", [...p, "mymod"]);
setShared("chatbar.agents.mymod", {
  t4: {
    title: "Fix the login redirect", // optional: replaces the terminal title
    context: "blue",                  // optional: a context id (see 3.)
    label: "Blue",                    // optional: the tag text (else the hook's label for the context)
    color: "ansi4",                   // optional: a theme color name or #hex (else the hook's color)
    hidden: false,                    // optional: dims the bubble as "not in the current view"
    progress: { done: 3, total: 7, eta: 4 }, // optional: the agent's task list; eta in minutes, or null
    doing: "Editing src/cart/total.ts",      // optional: one line, what it is doing now
    session: "/path/to/transcript.jsonl",    // optional: where to read progress from, when you don't publish it
  },
});
```

All fields are optional. Providers are merged in the order they registered; a later provider wins per field,
and `null` or missing fields are skipped. Compare before you write: setting shared state re-renders every mod.

Without any provider the title is the terminal's title, else the tab name, else the program name. Without a
context there is no tag and the header uses the accent color.

**Progress.** For Claude Code agents the chat bar shows task-list progress ("3/7", a ring) and what the agent is
doing now. A provider's `progress` and `doing` are used as given, and the chat bar reads nothing for that agent.
Without them it runs `progress.py` (python3, every 5 s at most, only for agents shown in the bar or working out of
sight) on the transcript: the provider's `session` path, else the Claude process under the terminal's pid and its
`~/.claude/sessions/<pid>.json`, else the newest transcript in `~/.claude/projects/<folder slug>/`. It reads the
latest `TodoWrite` list or `TaskCreate`/`TaskUpdate` tasks and the last tool call, appended bytes only. Publish
`session` if you know the terminal's transcript better (another config folder, say). `progress.py` is plain Python
and can be imported: `progress_of(path, cache)` returns `{done, total, eta, doing}`.

## 3. Context hook: `goto.context`

The chat bar reads the same context hook as the Go to mod (its PROVIDERS.md, section 3), so one hook serves both:

```js
setShared("goto.context", {
  request: "mymod.request",          // where "Go to" writes {context, run, at}
  layouts: ["main"],                 // optional: only in these layouts (where the hook mod listens)
  current: "blue",                   // optional: the context shown now
  spaces: { "<space id>": "blue" },  // optional: context per space
  terminals: { t4: "red" },          // optional: context per terminal
  labels: { blue: "Blue" },          // optional: the tag text per context
  colors: { blue: "ansi4" },         // optional: the tag color
});
```

- **An agent's context**: a provider's `context`, else `terminals[address]`, else `spaces[space]`.
- **Label and color**: a provider's, else `labels[context]` (else the id itself) and `colors[context]`.
- **Hidden**: a provider's `hidden`, else true when `current` is set and the agent's context is another one.
  Hidden bubbles and heads are dimmed, not removed.
- **Go to** on a bubble: with a hook that listens in the shown layout, the chat bar writes
  `{context, run: [["pane.focus", {terminal}]], at}` to `request`. The hook mod switches whatever it needs
  (for example the shown context) and runs `run` in order. Without a hook it focuses the pane itself.

## 4. Go to (optional)

When the Go to mod is installed, the chat bar registers the provider `chatbar` in `goto.providers` and publishes
`goto.items.chatbar`: one "Reply to <title>" item per agent that needs you or finished, with its context.
Picking one sets `chatbar.request` to `{action: "open", terminal, from: "goto"}`, which opens that bubble
without leaving the current view. Without Go to these keys are simply unused.

## 5. Dictation (optional)

When the dictate mod is installed (it sets `dictate.api = {version: 1, ready, hint}`), each bubble's reply field
gets a mic. A click sets `dictate.request` to
`{action: "toggle", id: "chatbar:<address>", reply: {key: "chatbar.request", value: {action: "draft", terminal, append: true}}}`;
dictate records, transcribes and writes `{...value, text}` back to `chatbar.request`, so the text lands in that
bubble's reply field, unsent. The mic reads `dictate.state` (`{status, id}`) to show recording and transcribing.
Not ready (`ready: false`): the mic is dimmed and its tooltip says what to install. Without dictate there is no mic.
The command `chatbar.mic` (keys.json, or `herdr-app do chatbar.mic`) does the same for the front bubble;
`chatbar.mic:<address>` for that agent's.

## Keys the chat bar writes

| Key | Shape | When |
|---|---|---|
| `chatbar.api` | `{version: 1}` | on start; `null` when the bar's last copy closes (removed, quit) |
| `chatbar.request` | `null` | after taking a request |
| `chatbar.closed` | `{<address>: status}` | a bubble closed until its agent's status changes |
| `goto.providers`, `goto.items.chatbar` | see 4. | on start, and when the list changes |
| `dictate.request` | see 5. | the mic is clicked |
| the hook's `request` | `{context, run, at}` | "Go to" with a context hook |
