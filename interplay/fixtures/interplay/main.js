// Demo only (interplay/README.md): the interplay suite's hand inside the demo window. Not a mod for real use.
// - control/set.json {seq, set: {key: value}}: sets shared keys, once per seq (run.py writes it).
// - interplay-log/<copy>.jsonl: every change of the WATCH keys this copy sees, one JSON line each, so run.py also
//   sees requests that live only until the receiver takes them.
// - The context hook's receiver: goto.context.request is "interplay.request"; it switches `current` to the
//   request's context and runs its commands, as a real hook mod (an account switcher) would.

import { View, div } from "gpui-kit";
import { shared, setShared, appHome, readTextFile, writeTextFile, watchFolder, run } from "herdr";

const WATCH = ["layout", "goto.api", "goto.providers", "goto.handlers.review", "goto.items.chatbar", "goto.items.review", "goto.demo.rows",
  "goto.context", "pr.goto", "review.target", "chatbar.api", "chatbar.request", "chatbar.closed", "dictate.api", "dictate.state",
  "dictate.request", "timetrack.contexts", "interplay.request"];

export default class Interplay extends View {
  init(_props, cx) {
    this.last = {};
    this.lines = [];
    this.written = null;
    this.out = `${appHome()}/interplay-log/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.jsonl`;
    const dir = `${appHome()}/control`;
    // The applied seq lives in shared state, so a copy started by a layout switch doesn't apply old sets again.
    const read = async () => {
      const c = JSON.parse((await readTextFile(`${dir}/set.json`).catch(() => null)) ?? "null");
      if (!c || !(c.seq > (shared("interplay.seq") ?? 0))) return;
      setShared("interplay.seq", c.seq);
      for (const [k, v] of Object.entries(c.set ?? {})) setShared(k, v);
    };
    cx.spawn(async () => { await read(); for (;;) { await watchFolder(dir); await read(); } });
  }

  flush(cx) {
    cx.spawn(async (cx) => {
      const text = this.lines.join("\n") + "\n";
      let ok = true;
      try { await writeTextFile(this.out, text, this.written); this.written = text; } catch { ok = false; }
      // More lines came in meanwhile: write again (not after a failed write, which would only fail again).
      if (ok && this.lines.join("\n") + "\n" !== this.written) return this.flush(cx);
      this.flushing = false;
    });
  }

  render(cx) {
    let changed = false;
    for (const k of WATCH) {
      const v = JSON.stringify(shared(k) ?? null);
      if (v === this.last[k]) continue;
      this.last[k] = v;
      this.lines.push(JSON.stringify({ t: Date.now(), k, v: JSON.parse(v) }));
      changed = true;
    }
    if (changed && !this.flushing) { this.flushing = true; cx.timer.after(0, (cx) => this.flush(cx)); }
    const req = shared("interplay.request");
    if (req && !this.taking) {
      this.taking = true;
      cx.timer.after(0, () => {
        this.taking = false;
        if (!shared("interplay.request")) return; // another copy took it
        setShared("interplay.request", null);
        const hook = shared("goto.context");
        if (hook && req.context && hook.current !== req.context) setShared("goto.context", { ...hook, current: req.context });
        for (const [name, args] of req.run ?? []) run(name, args ?? {});
      });
    }
    return div();
  }
}
