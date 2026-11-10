# Conventions: how the mods plug into each other

Every mod in this set works alone. When two of them are installed, they find each other through Herdr's shared
state (`shared(key)` and `setShared(key, value)`) and nothing else. This page is the part of the contract they all
share. Each mod's own PROVIDERS.md has its keys and shapes:

| Mod | Contract |
|---|---|
| goto | [PROVIDERS.md](https://github.com/saefty/herdr-corgi-goto/blob/main/mods/goto/PROVIDERS.md) |
| pr-review | [PROVIDERS.md](https://github.com/saefty/herdr-corgi-pr-review/blob/main/mods/pr-review/PROVIDERS.md) |
| chatbar | [PROVIDERS.md](https://github.com/saefty/herdr-corgi-chatbar/blob/main/mods/chatbar/PROVIDERS.md) |
| timetrack | [PROVIDERS.md](https://github.com/saefty/herdr-corgi-timetrack/blob/main/mods/timetrack/PROVIDERS.md) |
| dictate | [PROVIDERS.md](https://github.com/saefty/herdr-corgi-dictate/blob/main/mods/dictate/PROVIDERS.md) |

## The rules

1. **Load order never matters.** A mod reads the keys it uses every time it renders (or on a short timer while it is
   open), and a provider writes its keys whether or not the mod that reads them is installed.
2. **A missing partner never errors.** No key, no feature: the mod falls back to what it does alone and says
   nothing.
3. **Shared state only.** A mod never reads another mod's files or imports its code. The one exception is what a
   PROVIDERS.md documents as a public entry point (timetrack's `track.py --facts` and its `status.json`).
4. **Keys are namespaced** by the mod: `goto.*`, `chatbar.*`, `dictate.*`, `timetrack.*`. pr-review uses
   `review.*` and `pr-review.*`. A provider's own data goes under the hub's key with the provider's name last:
   `goto.items.<provider>`.
5. **Fields are only added.** An existing field never changes its meaning or type. Readers ignore fields they
   don't know.
6. **Compare before you write.** Every `setShared` re-renders every mod, so write only when the value changed:
   `if (JSON.stringify(shared(k)) !== JSON.stringify(v)) setShared(k, v)`.
7. **Contexts are opaque ids.** `"blue"` means whatever the mod that defines it says. Other mods only compare ids
   and show the label and color they are given.

## Announce: `<mod>.api`

A mod that others can call sets `<mod>.api` when it starts:

```js
if (shared("goto.api")?.version !== 1) setShared("goto.api", { version: 1 });
```

- `version` is the contract's major version, the number in the title of its PROVIDERS.md.
- A mod may add its own fields: dictate publishes `{version: 1, ready, hint}` so a consumer can dim its mic and
  say what to install.
- Consumers test for the key (is it there?) and for the fields they need, not for an exact version.

Today `goto.api`, `chatbar.api` and `dictate.api` exist. pr-review and timetrack are read through their published
keys instead.

## Ask a mod to do something: `<mod>.request`

```js
setShared("chatbar.request", { action: "draft", terminal: "t7", text: "...", from: "mymod", at: Date.now() });
```

- `action` says what to do. The other fields belong to that action.
- `from` and `at` are optional, for the sender's bookkeeping.
- The receiver takes the request on its next render and sets the key back to `null`, so the same request can be
  sent again.
- One request at a time. A second write before the first is taken replaces it.
- Only send to a mod whose `.api` is set. Without it, do the plain thing yourself (pr-review pastes into the
  terminal when there is no chat bar).

**Getting an answer back.** Put a `reply` in the request: `{key, value}`. The receiver writes `{...value, <result>}`
to `reply.key` and changes nothing else in `value`. Dictate works this way, and the chat bar's mic hands it
`reply: {key: "chatbar.request", value: {action: "draft", terminal, append: true}}`, so the text lands straight in
a bubble.

**Hand-overs.** A hand-over is a request a mod picks up in its own render, for example `review.target` (the PR the
review layout shows) or `pr.goto`. goto sets them with its pseudo-command `["goto.set", {key, value}]`.

## Provide data to a hub: `<hub>.providers` and `<hub>.<kind>.<provider>`

goto and the chat bar collect data from any number of providers:

```js
const p = shared("goto.providers") ?? [];
if (!p.includes("mymod")) setShared("goto.providers", [...p, "mymod"]);
setShared("goto.items.mymod", [{ id: "a1", title: "Reply to t9", run: [["pane.focus", { terminal: "t9" }]] }]);
```

- Register the provider name once in `<hub>.providers`, then write your own key. Never edit another provider's key.
- The kinds in use: `goto.items`, `goto.handlers`, `goto.repos`, `chatbar.agents`.
- How a hub combines providers is in its PROVIDERS.md. The chat bar, for example, merges them in the order they
  registered: a later provider wins per field, and `null` or a missing field is skipped.

## Describe UI as data

What one mod shows inside another is data, not code: items, cards and rows with `title`, `subtitle`, `tag`,
`color`, `progress`, `context`, and actions as a list of app commands `[[command, args], ...]` run in order. The
hub draws them in its own style. Colors are a theme color name (`"ansi4"`, `"accent"`) or `#hex`.

A mod that needs richer UI draws its own block, placed by a layout (`{ "mod": "<name>" }` in a layout, or a
floating entry) or opened with `openOverlay`.

## One context hook: `goto.context`

One mod may own "contexts" (profiles, clients, accounts) and tell all the others about them through a single key.
The shape is in [goto's PROVIDERS.md, section 3](https://github.com/saefty/herdr-corgi-goto/blob/main/mods/goto/PROVIDERS.md#3-context-hook-gotocontext):

```js
setShared("goto.context", {
  request: "mymod.request",          // where a mod writes {context, run, at} instead of running run itself
  layouts: ["main"],                 // optional: the layouts where the hook mod listens
  current: "blue",                   // optional: the context shown now
  spaces: { "<space id>": "blue" }, terminals: { t4: "red" },
  labels: { blue: "Blue" }, colors: { blue: "ansi4" },
  env: { blue: { CLAUDE_CONFIG_DIR: "/path/to/.claude-blue" } },
});
```

- goto, the chat bar and timetrack read it. Each uses the fields it needs and ignores the rest.
- A mod that would switch contexts before an action writes `{context, run: [[command, args], ...], at}` to the
  hook's `request` when the hook listens in the shown layout. The hook mod switches and runs `run`. Without a hook,
  the mod runs the commands itself.
- pr-review keeps its own richer `pr-review.contexts` (rules on folders and remotes, clone roots, per-context env).
  A hook mod that serves both writes both keys from the same data.

## Settings, keys and commands

- Settings live in `<app home>/<mod>.config.json`. Every key is optional and has a default.
- A mod's commands are `<mod>.<command>` (`dictate.toggle`). A command reaches only a copy in the shown layout, so a
  mod that has no visible block of its own needs a floating entry there. The README says so.
- A sample `keys.json` sits at the repo root. corgi merges it only with the person's consent and never rebinds a
  key that is already taken.

## Versions and changes

Each mod repo has a `corgi.json` next to `mod.json`:

```json
{ "name": "goto", "version": "1.2.0", "requires": { "herdr-app": ">=0.1.14" }, "provides": { "goto-api": 1 }, "keys": "keys.json" }
```

- `version` is the release, tagged `vX.Y.Z`, with a `## X.Y.Z` section in `CHANGELOG.md`.
- `provides` names the contract majors this mod publishes. `requires` names what it needs, and corgi refuses an
  update whose `requires` isn't met.
- Adding fields, actions or kinds is a minor change. Changing or removing one is a breaking change: it gets a new
  contract major, and for one release the provider publishes both the old and the new shape.
- New mod folders start with `mod.json` saying `"place": "none"`, so Herdr doesn't dock a copy anywhere the person
  didn't ask for.
