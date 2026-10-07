/**
 * Glossary: words that must always come out the same (names, brands, terms). `from` is a word of the original
 * (Chinese, English) or a Khmer word the translator gets wrong; `to` is the Khmer to use. Shared by the server
 * (translation) and the editor (applied to lines already translated); no Node imports here.
 */
export type GlossEntry = { from: string; to: string };

export function parseGlossary(v: unknown): GlossEntry[] {
  return (Array.isArray(v) ? v : []).slice(0, 500).map((e) => ({
    from: String(e?.from ?? "").replace(/[\r\n]/g, " ").trim().slice(0, 100),
    to: String(e?.to ?? "").replace(/[\r\n]/g, " ").trim().slice(0, 100),
  })).filter((e) => e.from && e.to);
}

/** Every glossary word in `text` replaced by its Khmer; longer entries first (so "Li Ming" wins over "Li"). */
export function applyGlossary(text: string, g: GlossEntry[]): string {
  for (const e of [...g].sort((a, b) => b.from.length - a.from.length)) {
    const esc = e.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // whole words for Latin letters ("Li" not inside "Like"); Chinese and Khmer have no spaces between words
    const pre = /^\w/.test(e.from) ? "\\b" : "", post = /\w$/.test(e.from) ? "\\b" : "";
    text = text.replace(new RegExp(pre + esc + post, "giu"), () => e.to);
  }
  return text;
}
