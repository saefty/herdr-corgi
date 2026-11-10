# Go to: the plug-in contract (version 1)

The rules every mod in the herdr-corgi set shares (announcing, requests, providers, the context hook,
versions) are in [CONVENTIONS.md](https://github.com/saefty/herdr-corgi/blob/main/CONVENTIONS.md). This page has
what is specific to this mod.

Go to finds what is already open (spaces, tabs, agents, terminals), local git repos, GitHub PRs and repos,
paths, URLs, layouts and app commands. Other mods add to it through shared state only. Nothing here is
required. Go to never reads another mod's files, and a mod that writes these keys works without Go to.

Go to sets `goto.api = {version: 1}` when it opens, so a mod can check the version. Providers write their
keys whether or not Go to is installed. Load order doesn't matter, because Go to reads the keys each time it opens and every 2 s while it is open.

## Registering

Add your provider name once to the list in `goto.providers`:

```js
const p = shared("goto.providers") ?? [];
if (!p.includes("mymod")) setShared("goto.providers", [...p, "mymod"]);
```

## 1. Items: `goto.items.<provider>`

```js
setShared("goto.items.mymod", [{
  id: "a1",                       // unique within the provider
  title: "Reply to t9",
  subtitle: "waiting 5m",         // optional, shown dim
  text: "longer searchable text", // optional (prompts, a description), shown as the matching snippet
  keywords: ["SHELF-12", "https://github.com/o/r/pull/3"], // optional, ranked above text
  tag: "Chat",                    // optional, the chip on the right (else the context's label)
  context: "blue",                // optional, see 3.
  weight: 1.2,                    // optional score factor
  url: "https://github.com/o/r/pull/3", // optional: an item for this PR replaces this provider's handler row
  // what it does, one of:
  focus: { terminal: "t9" },      // or {space} or {space, tab}: an open thing
  run: [["pane.focus", { terminal: "t9" }], ["goto.set", { key: "chat.open", value: "t9" }]],
}]);
```

An item whose `focus.terminal` is a terminal Go to already lists adds to that entry instead of adding a
second one. It can replace the title and add text, keywords, context, tag and weight. Use this to give agents better names
and searchable topics. Other items are ranked with Go to's own entries. Items with `focus` rank with what
is open. Items with `run` rank with commands.

`run` is a list of `[command, args]` app commands, run in order. The pseudo-command
`["goto.set", {key, value}]` sets a shared value first, so a mod can be handed a request
(e.g. `{key: "chat.open", value: "t9"}`) that it handles in its own render.

## 2. Input handlers: `goto.handlers.<provider>`

```js
setShared("goto.handlers.review", [{
  pattern: "github\\.com/([\\w.-]+)/([\\w.-]+)/pull/(\\d+)", // a RegExp source, flags default "i"
  title: "Review PR #{number} · {title}",
  subtitle: "{owner}/{repo}",
  context: "blue",                // optional
  run: [["goto.set", { key: "review.target", value: { url: "{url}", number: "{number}" } }], ["layout.switch", { name: "review" }]],
}]);
```

Every handler whose pattern matches the input becomes a row. For a GitHub PR given in any form (URL,
`owner/repo#n`, `repo#n`, `#n`), the pattern is also tried against the canonical PR URL. Placeholders in
`title`, `subtitle`, `context` and anywhere in `run`:

- `{0}` … `{9}` and named groups: the match
- `{query}`: the input, `{layout}`: the shown layout
- for PRs: `{owner} {repo} {number} {url} {title} {state} {head} {base}`. Go to fetches the title with `gh pr view` and
  updates the row when it arrives.

A string that is only one placeholder (`"{number}"`) takes the value as it is, so numbers stay numbers.
Without any handler, a PR offers "Open in browser".

## 3. Context hook: `goto.context`

One mod may own the context: a grouping of things (a profile, a client) that may need switching before
an action runs.

```js
setShared("goto.context", {
  request: "mymod.request",          // Go to writes {context, run, at} here instead of running
  layouts: ["main"],                 // optional: only in these layouts (where the hook mod listens)
  current: "blue",                   // optional: the context shown now; preferred when a name is ambiguous
  spaces: { "<space id>": "blue" },  // optional: context per space
  terminals: { "t4": "red" },        // optional: context per terminal
  folders: [["~/code/red", "red"]],  // optional: folder prefix -> context (the longest prefix wins)
  remotes: [["github\\.com/red-org/", "red"]], // optional: URL regex -> context, for repos and PRs
  labels: { blue: "Blue" },          // optional: the tag text per context
  colors: { blue: "ansi4" },         // optional: the tag color (theme color name or #hex)
  env: { blue: { CLAUDE_CONFIG_DIR: "/path/to/.claude-blue" }, red: { CLAUDE_CONFIG_DIR: null } }, // optional, see below
});
```

An entry's context is its own `context`, else its terminal's, its space's, its folder's or its remote's.
With a hook registered and listening in the shown layout, Go to sets the `goto.set` values and then writes
`{context, run: [[command, args], …], at}` to `request`. The hook mod switches whatever it needs and runs
`run` in order. A run with `space.new` creates a space. Without a hook, Go to runs the commands itself.

"Start agent" sends a `tab.new` (or `space.new`) with `argv` and `task` the same way. `env` sets what an agent
started in a context runs with: Go to replaces the agent's own leading `env NAME=value` settings with the
context's (`null` unsets a name), e.g. `["env", "CLAUDE_CONFIG_DIR=/path/to/.claude-blue", "claude"]`.

`goto.config.json` in the app home can set a clone folder per context:
`{"roots": ["~/code"], "depth": 4, "cloneTo": {"default": "~/code", "red": "~/red/code"}}`.

## 4. Repos: `goto.repos.<provider>`

```js
setShared("goto.repos.mymod", [{ owner: "octo", name: "bookshelf", path: "/abs/path/or/null", context: "blue", at: 1700000000000 }]);
```

These help resolve a bare `bookshelf` or `bookshelf#12` to `octo/bookshelf`, together with the local clones Go to finds
under `roots` (and, as a last step, `gh repo view <owner>/<name>` for the owners seen so far).

## 5. Ask: `goto.ask`

A mod that can answer "which open session is this about?" registers:

```js
setShared("goto.ask", { request: "mymod.ask", answer: "mymod.ask.answer", subtitle: "one model call", layouts: ["main"] });
```

Only when the person picks "Ask: find the session about …" does Go to write
`{query, items: [{id, title, where, topic}], at}` to `request`. Answer with
`{at, matches: [{id, reason}]}` (or `{at, error}`) in `answer`. The `id`s are entry ids from `items`.
