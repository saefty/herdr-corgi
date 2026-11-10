// Where dictated text goes (PROVIDERS.md), as pure functions so node can test them without Herdr.

export const API_VERSION = 1;

// A "dictate.request" -> {action, id, reply} or null. reply: {key, value}: the text goes to shared state there
// as {...value, text} instead of being typed.
export function readRequest(req) {
  if (!req || !["toggle", "start", "stop", "cancel"].includes(req.action)) return null;
  const r = req.reply;
  const reply = r && typeof r.key === "string" && r.key && r.value && typeof r.value === "object" && !Array.isArray(r.value)
    ? { key: r.key, value: r.value } : null;
  return { action: req.action, id: typeof req.id === "string" ? req.id : null, reply };
}

// One line, no line breaks: pasted into a terminal it can never press Enter.
export function oneLine(text) {
  return String(text ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
}

// What to do with a transcript: answer the requester, paste into the focused terminal, or leave it on the
// clipboard (no terminal has focus, e.g. a mod's input). null for nothing heard.
export function deliver(text, reply, terminal) {
  const t = oneLine(text);
  if (!t) return null;
  if (reply) return { kind: "reply", key: reply.key, value: { ...reply.value, text: t } };
  return terminal ? { kind: "paste", terminal, text: t } : { kind: "clipboard", text: t };
}

// 0:07, 1:23.
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// voice.py status -> null when ready, else what to install (never installed for you).
export function setupHint(st) {
  if (!st) return "Couldn't run python3 for dictation.";
  if (!st.macos) return "Dictation works on macOS only.";
  const missing = [!st.ffmpeg && "brew install ffmpeg", !st.parakeet && "uv tool install parakeet-mlx"].filter(Boolean);
  return missing.length ? `Dictation needs: ${missing.join(" · ")}` : null;
}
