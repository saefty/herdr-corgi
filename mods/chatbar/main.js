// Chat bar: a box per agent that needs you (blocked), finished-and-unseen agents as round heads.
// Answer from any layout: numbered choices as buttons (hc keys), a reply field (hc send),
// the live terminal in a window, or go to its pane. Floats bottom-right through the layouts'
// "floating" lists; renders nothing (so the float hides) when nobody waits.
// Screens are read (hc read, ~0.4 s) only for open blocked boxes, once per status change or open.
// Claude Code agents shown here get task-list progress and "now doing" (progress.py, every 5 s at most),
// unless a provider already publishes them. Working agents with a task list wait as small ringed heads.
// Other mods plug in through shared state only (PROVIDERS.md): chatbar.request, chatbar.agents.<provider>,
// the "goto.context" hook, and Go to's items.

import { View, div, image, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, spaces, panes, terminals, focused, shared, setShared, theme, run, hc, exec, appHome, openOverlay, notify, settings, nextCommand } from "herdr";
import { parseScreen } from "./screen.js";
import { API_VERSION, mergeProviders, infoFor, goTo, readRequest, gotoItems, progressLine } from "./plugins.js";

const MAX_OPEN = 3, MAX_BUSY = 4, W = 360, LINE = 18;
const MOTION = { duration: 180, easing: "ease-out" };
const STATUS = { blocked: "needs you", done: "finished", working: "working", idle: "idle" };

// Closed boxes, by the status they were closed in; shared so every layout's copy agrees.
const closedMap = () => shared("chatbar.closed") ?? {};

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}


function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

const isClaude = (a) => /claude/i.test(a.app ?? a.program?.name ?? "");

// A ring as a stroked polyline in % of its box (paint_path), from 12 o'clock clockwise.
function ringPath(frac, width, size) {
  const r = 50 - (50 * width) / size, n = Math.max(2, Math.round(48 * frac) + 1);
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * frac * i) / (n - 1);
    return [`${50 + r * Math.sin(a)}%`, `${50 - r * Math.cos(a)}%`];
  });
  return PathBuilder.stroke(width).add_polygon(pts, frac >= 1).build();
}

// done/total as a ring: the track, then the part done.
function ring(size, frac, track, fill, width = 2.5) {
  const layer = (f, c) => window.paint_path(ringPath(f, width, size), c).absolute().top(0).left(0).size_full();
  return div().relative().size(size).flex_none().child(layer(1, track)).when(frac > 0, (el) => el.child(layer(Math.min(frac, 1), fill)));
}

export default class Chatbar extends View {
  init(_props, cx) {
    // Others detect the contract here (pr-review hands drafts over only when it is set).
    if (shared("chatbar.api")?.version !== API_VERSION) setShared("chatbar.api", { version: API_VERSION });
    const p = shared("goto.providers") ?? [];
    if (!p.includes("chatbar")) setShared("goto.providers", [...p, "chatbar"]);
    this.since = {};          // address -> { status, at }: when it started waiting
    this.screens = {};        // address -> parsed screen for its current status ({ loading } while read)
    this.min = new Set();     // boxes folded to their header
    this.picked = [];         // opened from a head, newest first
    this.grown = new Set();   // boxes past their open flip (native height transition)
    this.reads = 0;
    this.asked = new Set();   // opened by a chatbar.request: shown whatever their status, until closed
    this.drafts = {};         // address -> {text, append} for its reply field, from a "draft" request
    this.progress = {};       // address -> {done, total, eta, doing} from progress.py, for agents no provider covers
    // One input per open slot, made here (InputState needs init); owner[i] is the address it types to.
    this.owner = Array(MAX_OPEN).fill(null);
    this.inputs = this.owner.map((_, i) => {
      const s = InputState.new({ placeholder: "Reply…" });
      s.on("submit", (_e, cx) => this.reply(i, cx));
      return s;
    });
    // Data only: the "waiting 5m" labels, and progress for the agents shown (poll skips when there are none).
    cx.timer.every(30000, (cx) => cx.notify());
    cx.timer.every(5000, (cx) => this.poll(cx));
    // keys.json "chatbar.mic": dictate into the front bubble (chatbar.mic:<address>: into that agent's).
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        if (c === "mic" || c.startsWith("mic:")) this.dictate(c.slice(4) || this.front);
        cx.notify();
      }
    });
  }

  // Removed or closed: what the bar announces goes with it, so pr-review falls back to its own window and Go to stops
  // offering "Reply to". Another copy that still runs announces them again on its next render.
  async close() {
    setShared("chatbar.api", null);
    setShared("goto.items.chatbar", null);
  }

  // Task-list progress and "now doing" for this.want ({address, pid, cwd, session}), outside render.
  poll(cx) {
    if (!this.want?.length || this.polling) return;
    this.polling = true;
    const want = this.want;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${appHome()}/mods/chatbar/progress.py`, JSON.stringify(want)], { timeout: 15000 });
        const out = r.stdout.trim();
        if (r.code === 0 && out && out !== this.lastProgress) {
          this.lastProgress = out;
          this.progress = JSON.parse(out);
          cx.notify();
        }
      } catch {}
      this.polling = false;
    });
  }

  // A provider's progress and "now doing" win over the bar's own read.
  progressOf(address) {
    const i = this.info.get(address) ?? {}, own = this.progress[address] ?? {};
    const p = i.progress ?? (own.total ? own : null);
    return { done: p?.done ?? 0, total: p?.total ?? 0, eta: p?.eta ?? null, doing: i.doing ?? own.doing ?? null };
  }

  read(address, cx, retry = false) {
    const id = ++this.reads;
    this.screens[address] = { loading: id, lines: [], options: [] };
    cx.spawn(async (cx) => {
      let next;
      try {
        const r = await hc(["read", address, "--json"]);
        next = r.code === 0 ? parseScreen(JSON.parse(r.stdout).text ?? "") : { lines: [], options: [], error: (r.stderr || r.stdout).trim() };
      } catch (e) {
        next = { lines: [], options: [], error: String(e) };
      }
      // Dropped when the status moved on (or another read started) meanwhile.
      if (this.screens[address]?.loading !== id) return;
      // The status can arrive before the prompt is drawn: an empty screen is read once more, a second later.
      if (!retry && !next.error && !next.lines.length && !next.options.length) {
        return cx.timer.after(1000, (cx) => { if (this.screens[address]?.loading === id) this.read(address, cx, true); });
      }
      this.screens[address] = next;
      cx.notify();
    });
  }

  // Always by address: the box's own agent, never the focused terminal.
  send(address, args, what, cx) {
    if (this.screens[address]) this.screens[address].sent = what;
    cx.notify();
    cx.spawn(async (cx) => {
      let r;
      try { r = await hc(args); } catch (e) { r = { code: 1, stderr: String(e), stdout: "" }; }
      if (r.code !== 0) {
        notify({ title: `Couldn't send to ${address}`, body: (r.stderr || r.stdout).trim().slice(0, 200), level: "error" });
        if (this.screens[address]) this.screens[address].sent = null;
      }
      cx.notify();
    });
  }

  reply(slot, cx) {
    const address = this.owner[slot];
    const text = this.inputs[slot].value().trim();
    const a = agents().find((x) => x.address === address);
    if (!a || !text) return;
    this.inputs[slot].set_value("");
    // A blocked program refuses plain sends; --force types into its dialog, as asked.
    this.send(address, ["send", ...(a.status === "blocked" ? ["--force"] : []), "--", address, text], `“${text}”`, cx);
  }

  open(address) {
    this.min.delete(address);
    this.picked = [address, ...this.picked.filter((x) => x !== address)];
    delete this.screens[address];
  }

  closeBox(a) {
    setShared("chatbar.closed", { ...closedMap(), [a.address]: a.status });
    this.picked = this.picked.filter((x) => x !== a.address);
    this.asked.delete(a.address);
  }

  // Another mod asks for a bubble: open it (and fill its reply field) once, then clear the key so the same ask works again.
  // Outside render: setting shared state re-renders every mod.
  take(cx) {
    const req = shared("chatbar.request");
    if (!req || this.taking) return;
    this.taking = true;
    cx.timer.after(0, (cx) => {
      this.taking = false;
      setShared("chatbar.request", null);
      const r = readRequest(req);
      if (!r) return;
      if (r.terminal in closedMap()) {
        const { [r.terminal]: _gone, ...closed } = closedMap();
        setShared("chatbar.closed", closed);
      }
      this.asked.add(r.terminal);
      if (r.text != null) this.drafts[r.terminal] = { text: r.text, append: r.append };
      this.open(r.terminal);
      cx.notify();
    });
  }

  // Agent info from the providers and the context hook, for every agent once per render.
  infos(all) {
    const extra = mergeProviders(shared("chatbar.providers"), (name) => shared(`chatbar.agents.${name}`));
    const hook = shared("goto.context") ?? null;
    return { hook, info: new Map(all.map((a) => [a.address, infoFor(a, extra[a.address], hook)])) };
  }

  publishGoto(all, info, cx) {
    const items = gotoItems(all.map((a) => ({ a, info: info.get(a.address) })));
    const json = JSON.stringify(items);
    if (json === this.lastItems) return;
    this.lastItems = json;
    cx.timer.after(0, () => { if (json !== JSON.stringify(shared("goto.items.chatbar"))) setShared("goto.items.chatbar", items); });
  }

  openTerminal(address) {
    openOverlay({
      kind: "window", key: `chatbar-${address}`, width: 780, height: 480,
      layout: { type: "column", children: [
        { type: "block", size: { px: 30 }, content: { mod: "peek", props: { terminal: address } } },
        { type: "block", content: { terminal: address } },
      ] },
    });
  }

  render(cx) {
    const t = theme();
    const now = Date.now();
    const all = agents();
    this.take(cx);
    if (shared("chatbar.api")?.version !== API_VERSION && !this.announcing) {
      this.announcing = true;
      cx.timer.after(0, () => { this.announcing = false; setShared("chatbar.api", { version: API_VERSION }); });
    }
    if (!shared("goto.items.chatbar")) this.lastItems = null;
    const { hook, info } = this.infos(all);
    this.info = info;
    this.hook = hook;
    this.publishGoto(all, info, cx);
    const tabs = new Map(spaces().flatMap((s) => s.tabs.map((tb) => [tb.id, tb])));

    // A status change starts the wait clock again and drops the cached screen.
    for (const a of all) {
      const prev = this.since[a.address];
      if (prev?.status === a.status) continue;
      let at = now;
      if (!prev) { const c = tabs.get(a.tab)?.changed_at; if (c) at = c < 1e12 ? c * 1000 : c; }
      this.since[a.address] = { status: a.status, at };
      delete this.screens[a.address];
    }

    // A closed box comes back once its agent's status changes.
    const closed = closedMap();
    const stale = Object.keys(closed).filter((k) => all.find((a) => a.address === k)?.status !== closed[k]);
    if (stale.length) {
      const next = { ...closed };
      for (const k of stale) delete next[k];
      setShared("chatbar.closed", next);
    }

    // Agents already on screen (any pane of the shown tab, or the focused one) get no box: you can see them.
    const shownTab = spaces().find((s) => s.active)?.tabs?.find((tb) => tb.active)?.id;
    const onScreen = new Set(panes().filter((p) => p.tab === shownTab && p.terminal).map((p) => p.terminal));
    const focusedT = focused()?.terminal;
    for (const x of this.asked) if (!all.some((a) => a.address === x)) this.asked.delete(x);
    const waiting = all.filter((a) => this.asked.has(a.address) || ((a.status === "blocked" || a.status === "done") && closed[a.address] !== a.status
      && !onScreen.has(a.address) && a.address !== focusedT));
    const byAddr = new Map(waiting.map((a) => [a.address, a]));
    this.picked = this.picked.filter((x) => byAddr.has(x));
    const at = (a) => this.since[a.address]?.at ?? now;
    const blocked = waiting.filter((a) => a.status === "blocked" && !this.picked.includes(a.address)).sort((x, y) => at(x) - at(y));
    const open = [...this.picked.map((x) => byAddr.get(x)), ...blocked].slice(0, MAX_OPEN);
    const openSet = new Set(open.map((a) => a.address));
    this.front = open[0]?.address ?? null;
    const heads = waiting.filter((a) => !openSet.has(a.address))
      .sort((x, y) => (x.status === y.status ? at(y) - at(x) : x.status === "blocked" ? -1 : 1));

    // Progress: Claude Code agents shown here, or working out of sight, that no provider covers.
    const offScreen = all.filter((a) => isClaude(a) && (byAddr.has(a.address)
      || (a.status === "working" && !onScreen.has(a.address) && a.address !== focusedT)));
    const pids = new Map(terminals().map((x) => [x.address, x.pid ?? null]));
    const cwds = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p.cwd]));
    const want = offScreen.filter((a) => !info.get(a.address).progress && !info.get(a.address).doing)
      .map((a) => ({ address: a.address, pid: pids.get(a.address) ?? null, cwd: cwds.get(a.address) ?? null, session: info.get(a.address).session }));
    const wantKey = JSON.stringify(want);
    if (wantKey !== this.wantKey) { this.wantKey = wantKey; this.want = want; this.poll(cx); }
    // Working agents with a task list: small ringed heads, newest change first. Without a list a ring says nothing.
    const busy = offScreen.filter((a) => a.status === "working" && !byAddr.has(a.address) && this.progressOf(a.address).total > 0)
      .sort((x, y) => at(y) - at(x)).slice(0, MAX_BUSY);

    // Inputs follow their agent; a freed one is cleared before another agent gets it.
    this.owner.forEach((addr, i) => {
      if (addr && !openSet.has(addr)) { this.owner[i] = null; this.inputs[i].set_value(""); }
    });
    for (const a of open) if (!this.owner.includes(a.address)) this.owner[this.owner.indexOf(null)] = a.address;
    for (const [addr, d] of Object.entries(this.drafts)) {
      const slot = this.owner.indexOf(addr);
      if (slot < 0) continue;
      const cur = this.inputs[slot].value().trim();
      this.inputs[slot].set_value(d.append && cur ? `${cur} ${d.text}` : d.text);
      delete this.drafts[addr];
    }
    for (const x of this.grown) if (!openSet.has(x)) this.grown.delete(x);

    for (const a of open) {
      if (a.status === "blocked" && !this.min.has(a.address) && !this.screens[a.address]) this.read(a.address, cx);
    }
    // New boxes mount folded and grow one flip later; GPUI animates the height natively.
    // ponytail: a one-shot flip, not an animation timer.
    if (open.some((a) => !this.grown.has(a.address)) && !this.flipping) {
      this.flipping = true;
      cx.timer.after(30, (cx) => {
        this.flipping = false;
        for (const x of this.owner) if (x) this.grown.add(x);
        cx.notify();
      });
    }

    if (!open.length && !heads.length && !busy.length) return div();
    return h_flex().id("chatbar").items_end().gap(10).px(4)
      .when(busy.length > 0, (el) => el.child(h_flex().gap(4).pb(9).items_center().children(busy.map((a) => this.head(t, a, true)))))
      .when(heads.length > 0, (el) => el.child(h_flex().gap(6).pb(4).items_center().children(heads.map((a) => this.head(t, a)))))
      // Right to left: the first box sits at the corner.
      .children([...open].reverse().map((a) => this.box(t, a, now)));
  }

  // The context's colour (a theme colour name or #hex), else the accent.
  tint(t, info) {
    return info.color ? t[info.color] ?? info.color : t.accent;
  }

  // small: a working agent with a task list (28 px, opens as an asked bubble). A task list draws the ring
  // in place of the status border.
  head(t, a, small = false) {
    const acc = this.info.get(a.address);
    const color = this.tint(t, acc);
    const p = this.progressOf(a.address);
    const size = small ? 28 : 38;
    const pic = icon(a.program, small ? 14 : 18, t.foreground);
    return div().id(`head-${a.address}`).relative().size(size).flex_none().rounded_full()
      .bg(t.raised).when(!p.total, (el) => el.border_2().border_color(t[a.status] ?? t.done))
      .flex().items_center().justify_center().cursor_pointer().accessibility_label(`Open chat with ${acc.title}`).opacity(acc.hidden ? 0.45 : 1)
      .hover((s) => s.bg(t.hover))
      .tooltip([acc.title, a.space_name, acc.label, STATUS[a.status] ?? a.status, progressLine(p),
        a.status === "working" ? p.doing : null].filter(Boolean).join(" · "))
      .on_click((_e, cx) => { if (small) this.asked.add(a.address); this.open(a.address); cx.notify(); })
      .child(pic ?? div().text_size(small ? 12 : 14).font_semibold().text_color(t.foreground).child(acc.title.slice(0, 1).toUpperCase()))
      .when(p.total > 0, (el) => el.child(ring(size, p.done / p.total, t.border, t[a.status] ?? t.done).absolute().top(0).left(0)))
      .child(div().absolute().right(-2).bottom(-2).size(small ? 10 : 12).rounded_full().border_2().border_color(t.background).bg(color));
  }

  box(t, a, now) {
    const addr = a.address;
    const acc = this.info.get(addr);
    const color = this.tint(t, acc);
    const min = this.min.has(addr);
    const grown = !min && this.grown.has(addr);
    const blocked = a.status === "blocked";
    const screen = this.screens[addr];
    const slot = this.owner.indexOf(addr);
    const waited = ago(now - (this.since[addr]?.at ?? now));
    const mono = settings().font_family ?? "JetBrains Mono";
    const p = this.progressOf(addr);

    const hdrBtn = (id, label, tip, fn) => div().id(id).w(24).h(24).flex_none().rounded(6)
      .flex().items_center().justify_center().text_size(14).cursor_pointer()
      .hover((s) => s.bg(t.background).text_color(t.foreground)).tooltip(tip).accessibility_label(tip).on_click(fn).child(label);

    const header = h_flex().h(42).px(10).gap(8).items_center().bg(color).text_color(t.background)
      .child(h_flex().id(`hd-${addr}`).flex_1().min_w(0).gap(8).items_center().cursor_pointer().tooltip(min ? "Open this chat." : "Minimize this chat.")
        .on_click((_e, cx) => {
          if (min) { this.min.delete(addr); delete this.screens[addr]; } else this.min.add(addr);
          cx.notify();
        })
        .child(p.total > 0
          ? div().id(`ring-${addr}`).flex_none().tooltip(progressLine(p)).child(ring(14, p.done / p.total, t.background + "55", t.background, 2.5))
          : div().id(`dot-${addr}`).size(9).flex_none().rounded_full().tooltip(`Agent status: ${a.status}.`).accessibility_label(`Agent status: ${a.status}`).border_1().border_color(t.background).bg(t[a.status] ?? t.done))
        .child(icon(a.program, 16, t.background))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(13.5).font_semibold().child(acc.title))
          .child(div().truncate().text_size(12.5).opacity(0.85)
            .child([a.space_name, acc.label, blocked ? `waiting ${waited}` : a.status === "done" ? `done ${waited} ago` : `${a.status} ${waited}`,
              progressLine(p)].filter(Boolean).join(" · ")))))
      .child(hdrBtn(`min-${addr}`, min ? "▴" : "▾", min ? "Open" : "Minimize", (_e, cx) => {
        if (min) { this.min.delete(addr); delete this.screens[addr]; } else this.min.add(addr);
        cx.notify();
      }))
      .child(hdrBtn(`x-${addr}`, "✕", "Close until its status changes", (_e, cx) => { this.closeBox(a); cx.notify(); }));

    const options = blocked ? screen?.options ?? [] : [];
    // A permission card says it all; a plan card keeps the plan's lines above it.
    const card = blocked ? screen?.card ?? null : null;
    const lines = card?.kind === "permission" ? [] : screen?.lines ?? [];
    const note = a.status === "done" ? "Finished. Reply to give it its next task."
      : a.status === "working" ? (p.doing ? `Working: ${p.doing}. A reply goes in as its next message.` : "Working. A reply goes in as its next message.")
      : !blocked ? "Idle. Reply to give it a task."
      : screen?.loading ? "Reading the screen…"
      : screen?.error ? `Couldn't read the screen: ${screen.error}`
      : card?.kind === "permission" ? null
      : !lines.length && !options.length ? "Waiting for you." : null;
    const shown = note ? 1 : card?.kind === "permission" ? 0 : Math.min(Math.max(lines.length, 2), 12);
    // Wrapped lines, roughly: the card's snippet (mono) and note at 360 px.
    const wraps = (text, per) => (text ?? "").split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / per)), 0);
    const cardH = card ? 8 + 20 + (card.snippet ? 12 + wraps(card.snippet, 42) * 17 : 0) + (card.note ? 4 + wraps(card.note, 50) * 17 : 0) : 0;
    // Explicit height so open/minimize animates; the screen scrolls if wrapped lines need more.
    const bodyH = (shown ? 16 + shown * LINE : 0) + cardH + 12 + options.length * 32 + (screen?.sent ? 22 : 0) + 44 + 36;

    const screenEl = v_flex().id(`scr-${addr}`).flex_1().min_h(0).overflow_y_scrollbar().px(10).py(8)
      .bg(t.background).text_size(12.5)
      .when(Boolean(note), (el) => el.text_color(t.muted).child(note))
      .when(!note, (el) => el.font_family(mono).text_color(t.foreground)
        .children(lines.map((l) => div().whitespace_normal().child(l || " "))));

    const body = v_flex().id(`body-${addr}`).w_full().overflow_hidden()
      .h(grown ? bodyH : 0).opacity(grown ? 1 : 0)
      .transition("height", MOTION).transition("opacity", MOTION)
      .when(shown > 0, (el) => el.child(screenEl))
      .when(Boolean(card), (el) => el.child(v_flex().px(10).pt(8).gap(4)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(card.title))
        .when(Boolean(card.snippet), (el) => el.child(div().px(8).py(5).rounded(6).bg(t.background).border_1().border_color(t.border)
          .font_family(mono).text_size(12).text_color(t.foreground).children(card.snippet.split("\n").map((l) => div().whitespace_normal().child(l)))))
        .when(Boolean(card.note), (el) => el.child(div().whitespace_normal().text_size(12).text_color(t.muted).child(card.note)))))
      .when(options.length > 0, (el) => el.child(v_flex().px(8).pt(8).gap(4).children(options.map((o) =>
        h_flex().id(`opt-${addr}-${o.key}`).h(28).px(10).gap(8).items_center().rounded(7)
          .border_1().border_color(t.input).bg(t.raised).text_size(12.5).text_color(t.foreground).cursor_pointer()
          .hover((s) => s.bg(t.hover).border_color(color)).tooltip(`Answer the agent with option ${o.key}.`)
          .on_click((_e, cx) => this.send(addr, ["keys", addr, o.key], `option ${o.key}`, cx))
          .child(div().flex_none().font_semibold().text_color(color).child(o.key))
          .child(div().flex_1().min_w(0).truncate().child(o.label))))))
      .when(Boolean(screen?.sent), (el) => el.child(div().px(10).pt(6).text_size(12.5).text_color(t.muted).truncate().child(`Sent ${screen.sent}`)))
      .child(h_flex().px(8).pt(8).gap(6).items_center()
        .child(div().flex_1().min_w(0).child(Input.new(this.inputs[slot]).h(34).px(10).rounded(17)
          .border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground)))
        .child(this.mic(t, addr)))
      .child(h_flex().h(36).px(8).gap(6).items_center().justify_end()
        .child(this.action(t, `term-${addr}`, "Open terminal", () => this.openTerminal(addr), "Open this agent's terminal."))
        .child(this.action(t, `go-${addr}`, "Go to", () => {
          // A context hook that listens here switches context first (e.g. a hidden one), then focuses.
          const g = goTo(addr, acc.context, this.hook, shared("layout"), Date.now());
          if (g.request) setShared(g.request.key, g.request.value);
          for (const [name, args] of g.run) run(name, args);
        }, "Jump to this agent's tab and focus it.")));

    return v_flex().id(`box-${addr}`).w(W).flex_none().rounded(10).overflow_hidden()
      .border_1().border_color(t.border).bg(t.popover).opacity(acc.hidden ? 0.5 : 1)
      .child(header).child(body);
  }

  // With the dictate mod (its dictate.api): record, and its text lands in this reply field (appended, not sent).
  // The mic's click and the chatbar.mic command: record, the text comes back as a draft for this bubble.
  dictate(addr) {
    const api = shared("dictate.api"), st = shared("dictate.state");
    if (!addr || !api?.ready || (st?.id === `chatbar:${addr}` && st.status === "transcribing")) return;
    setShared("dictate.request", { action: "toggle", id: `chatbar:${addr}`, from: "chatbar", at: Date.now(),
      reply: { key: "chatbar.request", value: { action: "draft", terminal: addr, append: true } } });
  }

  mic(t, addr) {
    const api = shared("dictate.api");
    if (!api) return null;
    const st = shared("dictate.state");
    const mine = st?.id === `chatbar:${addr}` ? st.status : null;
    const tip = !api.ready ? api.hint ?? "Dictation isn't set up"
      : mine === "recording" ? "Stop and transcribe" : mine === "transcribing" ? "Transcribing…" : "Dictate a reply (click again to stop)";
    return div().id(`mic-${addr}`).size(30).flex_none().rounded_full().flex().items_center().justify_center()
      .border_1().border_color(mine === "recording" ? t.blocked : t.input).cursor_pointer().tooltip(tip).accessibility_label(tip)
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.dictate(addr))
      .child(mine === "recording" ? div().size(10).rounded_full().bg(t.blocked).loop("opacity", { from: 0.35, to: 1, period: 1000 })
        : mine === "transcribing" ? div().text_size(13).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)
        : svg("mods/chatbar/mic.svg").size(15).text_color(api.ready ? t.muted : t.dim));
  }

  action(t, id, label, fn, tip) {
    return div().id(id).h(26).px(10).rounded(6).flex().items_center().text_size(12.5).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(() => fn()).child(label);
  }
}
