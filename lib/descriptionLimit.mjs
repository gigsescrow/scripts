/** Listing descriptions. A word is a run of non-whitespace. Bio stays on a character cap. */
export const LISTING_DESCRIPTION_MAX_WORDS = 4000;
/** Backstop so one enormous token cannot store megabytes under the word cap. */
export const LISTING_DESCRIPTION_MAX_CHARS = 60_000;

export function countWords(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function clampListingDescription(text) {
  const raw = String(text || "");
  const capped =
    raw.length > LISTING_DESCRIPTION_MAX_CHARS ? raw.slice(0, LISTING_DESCRIPTION_MAX_CHARS) : raw;
  if (countWords(capped) <= LISTING_DESCRIPTION_MAX_WORDS) return capped;
  let words = 0;
  let i = 0;
  while (i < capped.length && words < LISTING_DESCRIPTION_MAX_WORDS) {
    while (i < capped.length && /\s/.test(capped[i])) i++;
    if (i >= capped.length) break;
    words++;
    while (i < capped.length && !/\s/.test(capped[i])) i++;
  }
  return capped.slice(0, i);
}
