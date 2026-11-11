// The onboarding hint's rules, pure so test_hint.mjs can run them: when may the idle float show "⌘⇧M to dictate"?
// State lives in shared("dictate.hint") = { since, uses, dismissed, shown: [ms…] }: shared state survives a copy
// that starts fresh, localStorage would not.

export const HOUR = 3600e3;
export const LIMITS = { days: 28, gap: 2 * HOUR, perDay: 2, uses: 3 };
const SYMBOLS = { cmd: "⌘", shift: "⇧", alt: "⌥", opt: "⌥", ctrl: "⌃" };

export const startState = (now) => ({ since: now, uses: 0, dismissed: false, shown: [] });

export function shouldShow(s, now, L = LIMITS) {
  if (!s || !s.since || s.dismissed || s.uses >= L.uses) return false;
  if (now - s.since > L.days * 24 * HOUR) return false;
  const shown = s.shown ?? [];
  if (shown.length && now - shown[shown.length - 1] < L.gap) return false;
  const today = new Date(now).toDateString();
  return shown.filter((t) => new Date(t).toDateString() === today).length < L.perDay;
}

// Old stamps are dropped: nothing older than the window can matter.
export const withShown = (s, now) => ({ ...s, shown: [...(s.shown ?? []), now].slice(-20) });
export const withUse = (s) => ({ ...s, uses: (s.uses ?? 0) + 1 });
export const withDismissed = (s) => ({ ...s, dismissed: true });

// "cmd-shift-m" -> "⌘⇧M"; null when dictate.toggle is unbound.
export function toggleKeys(bindings) {
  const b = bindings.find((k) => k.action === "dictate.toggle");
  if (!b) return null;
  const parts = b.keys.split("-");
  return parts.map((p, i) => SYMBOLS[p.toLowerCase()] ?? (i === parts.length - 1 ? (p.length === 1 ? p.toUpperCase() : p) : p)).join("");
}

// The agent you are looking at just stopped and waits for you.
export const waiting = (prev, now) => prev === "working" && (now === "idle" || now === "done" || now === "blocked");
