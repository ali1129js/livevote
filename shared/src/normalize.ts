/**
 * Normalise an option label for duplicate detection:
 * case-folded, diacritics stripped, punctuation dropped, whitespace collapsed.
 * "  Café   Nero! " and "cafe nero" share the key "cafe nero".
 */
export function normalizeLabel(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en")
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Display form: trim and collapse inner whitespace, keep the user's casing. */
export function cleanLabel(label: string): string {
  return label.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}
