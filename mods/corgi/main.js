// Mod updates. One mod, two roles:
//   no overlay  the background checker: a floating block that draws nothing. Once a day it runs
//               `corgi.py status --json` and posts one notification when a new set of updates exists.
//   overlay     the popup (`mod.open {name: "corgi"}`, also the notification's action): what changed per mod,
//               and "Update", which runs `corgi.py update` in a new tab so the person sees every step.
// The last result is the shared key `corgi.status` (persisted), so the popup and every copy see the same check.
// Nothing updates by itself, and a failed check never notifies: the error shows only in the popup.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, notify, props, closeOverlay, run, shared, setShared, theme } from "herdr";
import { HOUR, due, readStatus, decide } from "./updater.js";

const LOGO = "mods/corgi/logo.png"; // paths are relative to the Herdr home

const KEY = "corgi.status";
const CONFIG = 'cat "${CORGI_HOME:-$HOME/.local/share/corgi}/config.json"'; // written by corgi.py: {clone}

const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);

export default class Corgi extends View {
  init(_props, cx) {
    this.overlay = props()?.overlay ?? null;
    this.busy = false;
    if (this.overlay) {
      if (!shared(KEY)?.checked) this.check(cx, false);
      return;
    }
    // ponytail: wakes hourly and checks when the last check is a day old; several copies (one per layout) share
    // `at`, so only the first one due runs it.
    const tick = (cx) => { if (due(shared(KEY)?.at, Date.now())) this.check(cx, true); };
    cx.timer.every(HOUR, tick);
    tick(cx);
  }

  check(cx, background) {
    if (this.busy) return;
    this.busy = true;
    const prev = shared(KEY) ?? {};
    setShared(KEY, { ...prev, at: Date.now() }); // claim the check before the slow part
    cx.spawn(async (cx) => {
      let clone = prev.clone ?? null, result;
      try {
        clone = JSON.parse((await exec("sh", ["-c", CONFIG])).stdout).clone;
        result = readStatus(await exec("python3", [`${clone}/corgi.py`, "status", "--json"], { timeout: 300_000 }));
      } catch (e) {
        result = { updates: [], errors: [], error: clone ? String(e?.message ?? e) : "corgi was not found. Run corgi.py once from its clone." };
      }
      const { title, notified } = decide(result, prev.notified ?? null);
      if (background && title) {
        notify({ title, body: "Click to see what changed.", level: "info", icon: LOGO, action: { name: "mod.open", args: { name: "corgi" } } });
      }
      setShared(KEY, { ...result, clone, at: Date.now(), checked: Date.now(), notified: background ? notified : prev.notified ?? null });
      this.busy = false;
      cx.notify();
    });
  }

  update() {
    const clone = shared(KEY)?.clone;
    if (clone) run("tab.new", { name: "corgi update", argv: ["python3", `${clone}/corgi.py`, "update"] });
    closeOverlay(this.overlay);
  }

  render(cx) {
    if (!this.overlay) return div();
    const t = theme();
    const s = shared(KEY) ?? {};
    const updates = s.updates ?? [];
    const button = (id, label, primary, onClick) => div().id(id).px(10).py(4).rounded(5).text_size(12).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((st) => st.bg(primary ? t.accent : t.hover)).on_click(onClick).child(label);
    const line = (color, text) => div().text_size(12).text_color(color).child(text);

    const body = this.busy ? [line(t.muted, "Checking...")]
      : s.error ? [line(t.blocked, s.error)]
      : !s.checked ? [line(t.muted, "Not checked yet.")]
      : updates.length ? updates.map((u) => v_flex().gap(4).child(
          h_flex().gap(6).text_size(13).child(div().font_semibold().text_color(t.foreground).child(u.name))
            .child(div().text_color(t.muted).child(`${u.from} → ${u.to}`)))
          .child(u.changelog ? TextView.markdown(`log-${u.name}`, u.changelog) : line(t.dim, "No changelog entry.")))
      : [line(t.muted, "Everything is up to date.")];

    return v_flex().id("root").size_full().bg(t.popover).p(14).gap(10).text_color(t.foreground)
      .child(h_flex().justify_between().items_center()
        .child(h_flex().gap(8).items_center().child(image(LOGO).size(22))
          .child(div().font_semibold().text_size(14).child("Corgi")).child(div().text_size(12).text_color(t.muted).child("Mod updates")))
        .child(div().text_size(11).text_color(t.dim).child(s.checked ? `Checked ${clock(s.checked)}` : "")))
      .child(v_flex().id("list").flex_1().gap(12).overflow_y_scrollbar().children(body)
        .children((s.errors ?? []).map((e) => line(t.dim, `${e.name}: ${e.error}`))))
      .child(h_flex().gap(8).justify_end()
        .child(button("again", "Check now", false, (_e, cx) => this.check(cx, false)))
        .when(updates.length > 0 && !this.busy, (el) => el.child(button("update", "Update", true, () => this.update()))));
  }
}
