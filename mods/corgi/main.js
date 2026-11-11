// Mod updates. One mod, two roles:
//   no overlay  the background checker: a floating block that draws nothing. Once a day it runs
//               `corgi.py status --json` and posts one notification when a new set of updates exists.
//   overlay     the popup (`mod.open {name: "corgi"}`, also the notification's action): what changed per mod,
//               and "Update", which runs `corgi.py update` in a new tab so the person sees every step.
// The last result is the shared key `corgi.status` (persisted), so the popup and every copy see the same check.
// Nothing updates by itself, and a failed check never notifies: the error shows only in the popup.
// A release waits min_release_age_days (config.json) before it counts as an update; until then the popup lists it as
// pending and nothing notifies. The popup's settings row changes that wait and the early-updates opt-in through
// `corgi.py config set`.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, notify, props, closeOverlay, run, shared, setShared, theme } from "herdr";
import { HOUR, due, readStatus, decide, shortDate } from "./updater.js";

const LOGO = "mods/corgi/logo.png"; // paths are relative to the Herdr home

const KEY = "corgi.status";
const CONFIG = 'cat "${CORGI_HOME:-$HOME/.local/share/corgi}/config.json"'; // written by corgi.py: {clone, min_release_age_days, early_updates}
const WARNING = (n) => `New releases wait ${n} days before Corgi offers them. That gives time to spot a bad or compromised release before it reaches your machine. Mods run with your user's permissions. Turn this on only if you trust the authors and want fixes the day they ship.`;

const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);

export default class Corgi extends View {
  async close() { if (this.overlay) setShared("corgi.open", false); }
  init(_props, cx) {
    this.overlay = props()?.overlay ?? null;
    this.busy = false;
    this.again = false; // a settings change arrived during a check: check once more after it
    this.confirmEarly = false;
    if (this.overlay) {
      setShared("corgi.open", true); // a bar can show its button as open
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
    if (this.busy) { if (!background) this.again = true; return; }
    this.busy = true;
    const prev = shared(KEY) ?? {};
    setShared(KEY, { ...prev, at: Date.now() }); // claim the check before the slow part
    cx.spawn(async (cx) => {
      let clone = prev.clone ?? null, settings = prev.settings ?? null, result;
      try {
        const cfg = JSON.parse((await exec("sh", ["-c", CONFIG])).stdout);
        clone = cfg.clone;
        settings = { days: cfg.min_release_age_days ?? 3, early: !!cfg.early_updates };
        result = readStatus(await exec("python3", [`${clone}/corgi.py`, "status", "--json"], { timeout: 300_000 }));
      } catch (e) {
        result = { updates: [], pending: [], errors: [], error: clone ? String(e?.message ?? e) : "corgi was not found. Run corgi.py once from its clone." };
      }
      const { title, notified } = decide(result, prev.notified ?? null);
      if (background && title) {
        notify({ title, body: "Click to see what changed.", level: "info", icon: LOGO, action: { name: "mod.open", args: { name: "corgi" } } });
      }
      setShared(KEY, { ...result, clone, settings, at: Date.now(), checked: Date.now(), notified: background ? notified : prev.notified ?? null });
      this.busy = false;
      cx.notify();
      if (this.again) { this.again = false; this.check(cx, false); }
    });
  }

  // `corgi.py config set <key> <value>`, shown at once, then a fresh check (the wait decides what counts as an update)
  setting(cx, key, value, settings) {
    const s = shared(KEY) ?? {};
    if (!s.clone) return;
    setShared(KEY, { ...s, settings });
    this.confirmEarly = false;
    // ponytail: one write chain, so quick stepper clicks land in order
    this.writes = (this.writes ?? Promise.resolve())
      .then(() => exec("python3", [`${s.clone}/corgi.py`, "config", "set", key, String(value), "--yes"])).catch(() => {});
    cx.spawn(async (cx) => { await this.writes; this.check(cx, false); });
    cx.notify();
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
    const pending = s.pending ?? [];
    const cfg = s.settings;
    const button = (id, label, primary, onClick) => div().id(id).px(10).py(4).rounded(5).text_size(12).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((st) => st.bg(primary ? t.accent : t.hover)).on_click(onClick).child(label);
    const line = (color, text) => div().text_size(12).text_color(color).child(text);

    const body = this.busy ? [line(t.muted, "Checking...")]
      : s.error ? [line(t.blocked, s.error)]
      : !s.checked ? [line(t.muted, "Not checked yet.")]
      : [...updates.map((u) => v_flex().gap(4).child(
          h_flex().gap(6).text_size(13).child(div().font_semibold().text_color(t.foreground).child(u.name))
            .child(div().id(`ver-${u.name}`).text_color(t.muted).tooltip("Installed version, then the newer version to update to.").child(`${u.from} → ${u.to}`)))
          .child(u.changelog ? TextView.markdown(`log-${u.name}`, u.changelog) : line(t.dim, "No changelog entry."))),
         ...(updates.length ? [] : [line(t.muted, "Everything is up to date.")]),
         ...pending.map((p) => line(t.muted, `${p.name} ${p.version} available on ${shortDate(p.available_on)}`).id(`pending-${p.name}`).tooltip("A newer release that is still within the waiting period."))];

    const small = (id, label, onClick) => div().id(id).px(6).rounded(4).text_size(12).cursor_pointer().bg(t.raised)
      .hover((st) => st.bg(t.hover)).on_click(onClick).child(label);
    const settings = !cfg || !s.clone ? []
      : this.confirmEarly ? [v_flex().gap(6).p(8).rounded(5).border_1().border_color(t.blocked)
          .child(line(t.foreground, WARNING(cfg.days)))
          .child(h_flex().gap(8).justify_end()
            .child(button("early-cancel", "Cancel", false, (_e, cx) => { this.confirmEarly = false; cx.notify(); }).tooltip("Keep early updates off."))
            .child(button("early-confirm", "Turn on early updates", true, (_e, cx) => this.setting(cx, "early-updates", "on", { ...cfg, early: true })).tooltip("Offer releases before the waiting period ends.")))]
      : [h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
          .child(div().child("Wait"))
          .child(small("days-down", "−", (_e, cx) => this.setting(cx, "min-release-age", Math.max(0, cfg.days - 1), { ...cfg, days: Math.max(0, cfg.days - 1) })).tooltip("Wait one day less before offering a release.").accessibility_label("Decrease waiting days"))
          .child(div().text_color(t.foreground).child(String(cfg.days)))
          .child(small("days-up", "+", (_e, cx) => this.setting(cx, "min-release-age", cfg.days + 1, { ...cfg, days: cfg.days + 1 })).tooltip("Wait one day longer before offering a release.").accessibility_label("Increase waiting days"))
          .child(div().flex_1().child("days before offering a release"))
          .child(small("early", `Early updates: ${cfg.early ? "on" : "off"}`, (_e, cx) => {
            if (cfg.early) this.setting(cx, "early-updates", "off", { ...cfg, early: false });
            else { this.confirmEarly = true; cx.notify(); }
          }).tooltip("Toggle offering releases before the waiting period ends."))];

    return v_flex().id("root").size_full().bg(t.popover).p(14).gap(10).text_color(t.foreground)
      .child(h_flex().justify_between().items_center()
        .child(h_flex().gap(8).items_center().child(image(LOGO).size(22))
          .child(div().font_semibold().text_size(14).child("Corgi")).child(div().text_size(12).text_color(t.muted).child("Mod updates"))
          .when(!!cfg?.early, (el) => el.child(div().id("early-badge").tooltip("Releases are offered before the waiting period ends.").px(6).rounded(4).text_size(11).border_1().border_color(t.blocked)
            .text_color(t.blocked).child("⚠ early updates on"))))
        .child(div().id("checked-at").tooltip("When updates were last checked.").text_size(11).text_color(t.dim).child(s.checked ? `Checked ${clock(s.checked)}` : "")))
      .child(v_flex().id("list").flex_1().gap(12).overflow_y_scrollbar().children(body)
        .children((s.errors ?? []).map((e) => line(t.dim, `${e.name}: ${e.error}`))))
      .children(settings)
      .child(h_flex().gap(8).justify_end()
        .child(button("again", "Check now", false, (_e, cx) => this.check(cx, false)).tooltip("Look for mod updates now."))
        .when(updates.length > 0 && !this.busy, (el) => el.child(button("update", "Update", true, () => this.update()).tooltip("Install the listed updates in a new tab."))));
  }
}
