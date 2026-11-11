// Dictation: a key (dictate.toggle) starts recording, the same key stops it; the text is transcribed on this
// Mac (parakeet-mlx, recorded by ffmpeg: voice.py) and pasted into the focused terminal without Enter.
// Floats as a small "● 0:12" while recording and "Transcribing…" after; renders nothing otherwise.
// Other mods ask through shared state (PROVIDERS.md): dictate.request with a reply key gets the text there.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { shared, setShared, exec, appHome, focused, run, notify, theme, nextCommand } from "herdr";
import { API_VERSION, readRequest, deliver, clock, setupHint } from "./route.js";

const VOICE = "mods/dictate/voice.py";
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const voice = (args, timeout = 20000) => exec("python3", [`${appHome()}/${VOICE}`, ...args], { timeout })
  .then((r) => { try { return JSON.parse(r.stdout); } catch { return { ok: false, error: (r.stderr || r.stdout).trim().slice(-300) }; } })
  .catch((e) => ({ ok: false, error: String(e) }));

export default class Dictate extends View {
  init(_props, cx) {
    this.status = "idle";     // idle | starting | recording | transcribing
    this.job = null;          // {id, reply}: who asked; no reply = paste into the focused terminal
    this.since = 0;
    this.hint = null;         // what to install, null when ready
    this.setup(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "toggle") this.toggle({ action: "toggle", id: "key", reply: null }, cx);
        else if (c === "cancel") this.cancel(cx);
        cx.notify();
      }
    });
  }

  // Which programs are there; published as dictate.api so the chat bar can show a mic (or why not).
  setup(cx) {
    cx.spawn(async () => {
      const st = await voice(["status"]);
      this.hint = setupHint(st?.ok ? st : null);
      this.api = { version: API_VERSION, ready: !this.hint, hint: this.hint };
      if (JSON.stringify(this.api) !== JSON.stringify(shared("dictate.api"))) setShared("dictate.api", this.api);
    });
  }

  publish() {
    const st = { status: this.status, id: this.job?.id ?? null, since: this.since || null };
    if (JSON.stringify(st) !== JSON.stringify(shared("dictate.state"))) setShared("dictate.state", st);
  }

  set(status, cx) {
    this.status = status;
    this.publish();
    cx.notify();
  }

  toggle(req, cx) {
    if (this.status === "recording") return this.stop(cx);
    if (this.status !== "idle" || req.action === "stop") return;
    if (this.hint) return notify({ title: "Dictation isn't set up", body: this.hint, level: "warning" });
    this.job = { id: req.id, reply: req.reply };
    this.since = Date.now();
    this.set("starting", cx);
    cx.spawn(async (cx) => {
      const r = await voice(["start", `${appHome()}/dictate.config.json`]);
      if (!r.ok) {
        notify({ title: "Couldn't start recording", body: r.error ?? "", level: "error" });
        this.job = null;
        return this.set("idle", cx);
      }
      this.since = Date.now();
      // Data only: the recording clock, while recording.
      this.tick = cx.timer.every(1000, (cx) => cx.notify());
      this.set("recording", cx);
    });
  }

  stop(cx) {
    this.tick?.cancel();
    this.set("transcribing", cx);
    cx.spawn(async (cx) => {
      const r = await voice(["stop"], 200000);
      const job = this.job;
      this.job = null;
      this.since = 0;
      this.set("idle", cx);
      if (!r.ok) return notify({ title: "Dictation failed", body: r.error ?? "", level: "error" });
      // Typed where focus is now (it may have moved while you spoke), or handed back to whoever asked.
      const d = deliver(r.text, job?.reply, focused()?.terminal ?? null);
      if (!d) return notify({ title: "Nothing heard", level: "info" });
      if (d.kind === "reply") return setShared(d.key, d.value);
      // A paste, not hc send: hc send presses Enter, and hc keys can't type every character.
      const before = cx.read_from_clipboard();
      cx.write_to_clipboard(d.text);
      if (d.kind === "clipboard") return notify({ title: "Dictated text copied", body: "No terminal has focus: paste it with ⌘V.", level: "info" });
      run("terminal.paste");
      // Put the person's clipboard text back once the paste has read it (ponytail: text only; an image on it stays replaced).
      cx.timer.after(500, (cx) => { if (before != null && cx.read_from_clipboard() === d.text) cx.write_to_clipboard(before); });
    });
  }

  cancel(cx) {
    if (this.status === "idle") return;
    this.tick?.cancel();
    this.job = null;
    this.since = 0;
    this.set("idle", cx);
    cx.spawn(async () => { await voice(["cancel"]); });
  }

  // Requests from other mods: taken once, outside render (setting shared state re-renders every mod).
  take(cx) {
    const req = shared("dictate.request");
    if (!req || this.taking) return;
    this.taking = true;
    cx.timer.after(0, (cx) => {
      this.taking = false;
      setShared("dictate.request", null);
      const r = readRequest(req);
      if (r?.action === "cancel") this.cancel(cx);
      else if (r) this.toggle(r, cx);
    });
  }

  // Nothing resident after Herdr closes this copy mid-recording. Removed or closed, dictate.api goes too, so the chat
  // bar shows no mic nobody answers; another copy that still runs announces it again on its next render.
  async close() {
    setShared("dictate.api", null);
    if (this.status !== "idle") await exec("python3", [`${appHome()}/${VOICE}`, "cancel"]);
  }

  render(cx) {
    if (this.api && !shared("dictate.api") && !this.announcing) {
      this.announcing = true;
      cx.timer.after(0, () => { this.announcing = false; setShared("dictate.api", this.api); });
    }
    this.take(cx);
    if (this.status === "idle") return div();
    const t = theme();
    const rec = this.status === "recording" || this.status === "starting";
    return h_flex().id("dictate").h(30).px(10).gap(8).items_center().text_size(12.5).text_color(t.foreground)
      .child(rec ? div().id("dictate-dot").size(9).rounded_full().bg(t.blocked).loop("opacity", { from: 0.35, to: 1, period: 1000 }).tooltip("Recording from your microphone.").accessibility_label("Recording")
        : div().id("dictate-spin").text_color(t.muted).frames(SPIN, 90).tooltip("Turning your recording into text.").accessibility_label("Transcribing"))
      .child(div().id("dictate-status").min_w(70).tooltip(rec ? "Time recorded so far." : "Transcribing your recording.").child(rec ? `Recording ${clock(Date.now() - this.since)}` : "Transcribing…"))
      .when(rec, (el) => el
        .child(this.button(t, "dictate-stop", "Stop", "Stop and transcribe (the dictation key does the same)", (cx) => this.stop(cx)))
        .child(this.button(t, "dictate-cancel", "✕", "Cancel: nothing is typed", (cx) => this.cancel(cx))));
  }

  button(t, id, label, tip, fn) {
    return div().id(id).h(22).px(8).rounded(6).flex().items_center().text_color(t.muted).cursor_pointer().tooltip(tip).accessibility_label(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      // A press the mod doesn't stop would drag the float.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { fn(cx); cx.notify(); }).child(label);
  }
}
