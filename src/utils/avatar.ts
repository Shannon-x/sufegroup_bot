/**
 * Derive a single-character avatar initial from a display name.
 *
 * Telegram nicknames frequently use "fancy" Unicode (mathematical script/italic
 * letters like 𝒦𝑒𝓇𝒾𝒶, or a leading emoji) which live in the astral plane and
 * are encoded as UTF-16 surrogate pairs. The previous `name.charAt(0)` returned
 * a lone surrogate — half a character — which renders as a broken "tofu" glyph
 * in the avatar circle.
 *
 * Fix: NFKC-normalise first (folds the math-alphanumeric letters back to plain
 * ASCII, so 𝒦 → K), then take the first *code point* (never half a surrogate
 * pair). Falls back to '?' for empty/whitespace-only names.
 */
export function avatarInitial(name?: string | null): string {
  const normalized = (name ?? '').normalize('NFKC').trim();
  for (const ch of normalized) {
    // for...of iterates by code point, so surrogate pairs stay intact.
    if (ch.trim()) return ch.toUpperCase();
  }
  return '?';
}
