// Dictation: a key (dictate.toggle) starts recording, the same key stops it; the text is transcribed on this
// Mac (parakeet-mlx, recorded by ffmpeg: voice.py) and pasted into the focused terminal without Enter.
// Floats as a small "● 0:12" while recording and "Transcribing…" after; renders nothing otherwise.
// While idle it may show a dim "⌘⇧M to dictate" chip for 5 s, rarely and only in the first weeks (hints.js).
// Other mods ask through shared state (PROVIDERS.md): dictate.request with a reply key gets the text there.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { shared, setShared, exec, appHome, focused, agents, keys, run, notify, theme, nextCommand } from "herdr";
import { API_VERSION, readRequest, deliver, clock, setupHint } from "./route.js";
import { startState, shouldShow, withShown, withUse, withDismissed, toggleKeys, waiting } from "./hints.js";

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
    this.seen = {};           // agent address -> last status, to notice "just stopped"
    this.chip = null;         // null | { keys, op }: the onboarding hint, op is its opacity
    this.setup(cx);
    if (!shared("dictate.hint")) setShared("dictate.hint", startState(Date.now()));
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

  // Onboarding hint: state is shared, so a copy started fresh doesn't restart the 28 days.
  hintState(f) { setShared("dictate.hint", f(shared("dictate.hint"))); }

  showChip(cx) {
    this.hintState((s) => withShown(s, Date.now()));
    this.chip = { keys: toggleKeys(keys()), op: 0 };
    cx.notify();
    // Data only: fade in, hold, fade out, remove (the fades themselves are `.transition`).
    this.chipTimer = cx.timer.after(60, (cx) => {
      if (this.chip) this.chip.op = 1;
      cx.notify();
      this.chipTimer = cx.timer.after(5000, (cx) => {
        if (this.chip) this.chip.op = 0;
        cx.notify();
        this.chipTimer = cx.timer.after(500, (cx) => this.hideChip(cx));
      });
    });
  }

  hideChip(cx) {
    this.chipTimer?.cancel();
    this.chip = null;
    cx.notify();
  }

  // The focused agent went from working to waiting: you are about to type.
  watchAgent(cx) {
    const a = agents().find((x) => x.focused);
    if (!a) return;
    const was = this.seen[a.address];
    this.seen[a.address] = a.status;
    if (!waiting(was, a.status) || this.chip || this.status !== "idle" || this.hint || !this.api || this.pending) return;
    if (!shouldShow(shared("dictate.hint"), Date.now())) return;
    this.pending = true; // a shared-state write re-renders every mod: not from inside render
    cx.timer.after(0, (cx) => { this.pending = false; if (this.status === "idle") this.showChip(cx); });
  }

  toggle(req, cx) {
    if (this.status === "recording") return this.stop(cx);
    if (this.status !== "idle" || req.action === "stop") return;
    if (this.hint) return notify({ title: "Dictation isn't set up", body: this.hint, level: "warning" });
    this.hideChip(cx);
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
      this.hintState(withUse);
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
    this.watchAgent(cx);
    if (this.status === "idle") return this.chip ? this.hintChip() : div();
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

  // Dim and small: no accent, no border, no sound. Clicking it is the toggle; × ends the hint for good.
  hintChip() {
    const t = theme();
    const label = this.chip.keys ? `🎙 ${this.chip.keys} to dictate` : "🎙 Dictate";
    const stop = (_e, cx) => cx.stop_propagation();
    return h_flex().id("dictate-hint").h(24).px(8).gap(6).items_center().text_size(11.5).text_color(t.dim ?? t.muted)
      .opacity(this.chip.op).transition("opacity", { duration: 400, easing: "ease-out" })
      .child(div().id("dictate-hint-go").cursor_pointer().tooltip("Press the key, speak, press it again. The text lands at your cursor; nothing is sent.")
        .accessibility_label("Start dictation").hover((s) => s.text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click((_e, cx) => { this.toggle({ action: "toggle", id: "key", reply: null }, cx); }).child(label))
      .child(div().id("dictate-hint-x").cursor_pointer().tooltip("Don't show this hint again").accessibility_label("Dismiss the dictation hint")
        .hover((s) => s.text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click((_e, cx) => { this.hintState(withDismissed); this.hideChip(cx); }).child("×"));
  }

  button(t, id, label, tip, fn) {
    return div().id(id).h(22).px(8).rounded(6).flex().items_center().text_color(t.muted).cursor_pointer().tooltip(tip).accessibility_label(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      // A press the mod doesn't stop would drag the float.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { fn(cx); cx.notify(); }).child(label);
  }
}
