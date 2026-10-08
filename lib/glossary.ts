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
  const c = compiled(g);
  return c ? text.replace(c.re, (...m) => c.to[m.slice(1, c.to.length + 1).findIndex((x) => x !== undefined)]) : text;
}

/**
 * All entries in one pattern, made once per glossary: the text is gone through once, so a shorter entry can't match
 * inside the Khmer an earlier entry put in, and hundreds of patterns are not built again for every line.
 */
const made = new WeakMap<GlossEntry[], { re: RegExp; to: string[] } | null>();
function compiled(g: GlossEntry[]) {
  if (made.has(g)) return made.get(g) ?? null;
  const sorted = g.filter((e) => e.from).sort((a, b) => b.from.length - a.from.length); // longest first: it wins where both fit
  const alt = sorted.map((e) => {
    const esc = e.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // whole words for Latin letters ("Li" not inside "Like"); Chinese and Khmer have no spaces between words
    const pre = /^\w/.test(e.from) ? "\\b" : "", post = /\w$/.test(e.from) ? "\\b" : "";
    return `(${pre}${esc}${post})`;
  });
  const c = sorted.length ? { re: new RegExp(alt.join("|"), "giu"), to: sorted.map((e) => e.to) } : null;
  made.set(g, c);
  return c;
}
