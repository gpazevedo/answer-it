// ─── Speech file parsing ──────────────────────────────────────────────────────

export function parseSpeech(text) {
  const items = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "---") {
      items.push({ type: "break" });
    } else if (trimmed.startsWith("## ")) {
      items.push({ type: "section", text: trimmed.slice(3) });
    } else if (trimmed.startsWith("**") && trimmed.endsWith("**") && trimmed.length > 4) {
      items.push({ type: "bold", text: trimmed.slice(2, -2) });
    } else if (trimmed !== "") {
      items.push({ type: "line", text: trimmed });
    }
  }
  return items;
}

// ─── TTS helpers ──────────────────────────────────────────────────────────────

/** Count sentences in a text block (used for sentence-boundary mapping). */
export function countSentences(text) {
  return (text.match(/[^.!?]*[.!?]+/g) || [text]).length;
}

/**
 * Map sentence boundary events to item indices using cumulative sentence counts.
 * Returns [{itemIdx, startMs}] — one entry per speakable item.
 */
export function buildItemTimings(speakableItems, boundaries) {
  if (!boundaries.length) return [];
  const timings = [{ itemIdx: 0, startMs: boundaries[0].offset_ms }];
  let offset = 0;
  for (let i = 0; i < speakableItems.length - 1; i++) {
    offset += Math.max(1, countSentences(speakableItems[i].text));
    if (offset < boundaries.length) {
      timings.push({ itemIdx: i + 1, startMs: boundaries[offset].offset_ms });
    }
  }
  return timings;
}
