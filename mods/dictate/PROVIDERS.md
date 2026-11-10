# Dictate: the plug-in contract (version 1)

The rules every mod in the herdr-corgi set shares (announcing, requests, providers, the context hook,
versions) are in [CONVENTIONS.md](https://github.com/saefty/herdr-corgi/blob/main/CONVENTIONS.md). This page has
what is specific to this mod.

Dictate works on its own: a key records, the same key transcribes, and the text is pasted into the focused
terminal without Enter. Other mods can ask for a recording through shared state and get the text back instead.
Dictate never reads another mod's files.

## 1. Is it there: `dictate.api`

```js
const api = shared("dictate.api"); // {version: 1, ready: true, hint: null}
```

- `ready`: ffmpeg and parakeet-mlx were found on this Mac.
- `hint`: when not ready, what to run, e.g. `"Dictation needs: brew install ffmpeg · uv tool install parakeet-mlx"`,
  or `"Dictation works on macOS only."`. Dictate never installs anything.

## 2. Ask for a recording: `dictate.request`

```js
setShared("dictate.request", {
  action: "toggle",                 // "toggle" (start, or stop if recording), "start", "stop" or "cancel"
  id: "mymod:t7",                   // optional: yours, echoed in dictate.state
  reply: { key: "mymod.dictated", value: { field: "note" } }, // optional: where the text goes
  from: "mymod", at: Date.now(),    // optional, for your own bookkeeping
});
```

- With `reply`, dictate writes `{...value, text}` to the shared key `reply.key` when the transcript is ready. Nothing
  is typed anywhere. Your value is kept as you gave it; only `text` is added.
- Without `reply`, the text is pasted into the terminal that has focus when transcription ends (the same as the
  key). With no terminal focused (a mod's input has the keyboard), it stays on the clipboard and a toast says so.
- `text` is always one line: line breaks and control characters are removed, so it can never press Enter.
- Dictate takes the request on its next render and sets the key back to `null`.

The chat bar's mic uses `reply: {key: "chatbar.request", value: {action: "draft", terminal, append: true}}`, so the
text lands in that bubble's reply field.

## 3. What it is doing: `dictate.state`

`{status: "idle" | "starting" | "recording" | "transcribing", id, since}`: `id` is the request's (`"key"` for the
key), `since` when recording started (ms). Use it to show your own recording state.

## Keys dictate writes

| Key | Shape | When |
|---|---|---|
| `dictate.api` | `{version, ready, hint}` | on start; `null` when its last copy closes (removed, quit) |
| `dictate.state` | see 3. | when the status changes |
| `dictate.request` | `null` | after taking a request |
| your `reply.key` | `{...value, text}` | when the transcript is ready |

## Command

`dictate.toggle` (and `dictate.cancel`) for `keys.json`, e.g. `"cmd-shift-m": "dictate.toggle"` in `global`. The
command reaches a copy that is in the shown layout, so dictate needs a `floating` entry there.
