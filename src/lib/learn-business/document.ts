/**
 * Turns a fetched page into INERT data: visible text, title/description,
 * JSON-LD structured data, and contact links. Scripts are never run —
 * JSON-LD is parsed as JSON, everything else executable is dropped.
 * Page content is untrusted: it describes the business, it never
 * instructs BARRY. The learner and the grounding step treat it that way.
 */

export type SourceDocument = {
  url: string;
  title?: string;
  description?: string;
  /** Visible text, one block per line, capped. */
  text: string;
  /** Parsed JSON-LD objects (flattened @graph), capped. */
  structuredData: Record<string, unknown>[];
  contactLinks: { tel: string[]; mailto: string[] };
  truncated: boolean;
};

const MAX_TEXT_CHARS = 20_000;
const MAX_STRUCTURED_ITEMS = 50;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  shekel: "₪",
  euro: "€",
  pound: "£",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : undefined;
}

function flattenJsonLd(value: unknown, out: Record<string, unknown>[]): void {
  if (out.length >= MAX_STRUCTURED_ITEMS || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, out);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj["@graph"])) {
    flattenJsonLd(obj["@graph"], out);
    return;
  }
  out.push(obj);
}

export function parseSourceDocument(url: string, body: string, contentType = "text/html", truncated = false): SourceDocument {
  if (!contentType.includes("html")) {
    const text = body.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return { url, text: text.slice(0, MAX_TEXT_CHARS), structuredData: [], contactLinks: { tel: [], mailto: [] }, truncated: truncated || text.length > MAX_TEXT_CHARS };
  }

  const structuredData: Record<string, unknown>[] = [];
  for (const m of body.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      flattenJsonLd(JSON.parse(m[1].trim()), structuredData);
    } catch {
      // Malformed structured data is ignored, never evaluated.
    }
  }

  const tel = new Set<string>();
  const mailto = new Set<string>();
  for (const m of body.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(m[0], "href");
    if (!href) continue;
    if (/^tel:/i.test(href)) tel.add(decodeURIComponent(href.slice(4)).trim());
    else if (/^mailto:/i.test(href)) mailto.add(decodeURIComponent(href.slice(7).split("?")[0]).trim());
  }

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() || undefined : undefined;
  let description: string | undefined;
  for (const m of body.matchAll(/<meta\b[^>]*>/gi)) {
    const name = (attr(m[0], "name") ?? attr(m[0], "property") ?? "").toLowerCase();
    if (name === "description" || name === "og:description") {
      description = attr(m[0], "content")?.replace(/\s+/g, " ").trim() || description;
      if (name === "description") break;
    }
  }

  const visible = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|object|embed|canvas|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|nav|li|ul|ol|h[1-6]|tr|td|th|table|dd|dt|dl|blockquote|figcaption|address)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(visible)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

  return {
    url,
    title,
    description,
    text: text.slice(0, MAX_TEXT_CHARS),
    structuredData,
    contactLinks: { tel: [...tel].slice(0, 10), mailto: [...mailto].slice(0, 10) },
    truncated: truncated || text.length > MAX_TEXT_CHARS,
  };
}

/** Everything a learned fact may legitimately quote from this document. */
export function groundingCorpus(doc: SourceDocument): string {
  const values: string[] = [];
  const collect = (v: unknown, depth: number) => {
    if (depth > 6) return;
    if (typeof v === "string" || typeof v === "number") values.push(String(v));
    else if (Array.isArray(v)) v.forEach((x) => collect(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => collect(x, depth + 1));
  };
  collect(doc.structuredData, 0);
  return [doc.title, doc.description, doc.text, ...values, ...doc.contactLinks.tel, ...doc.contactLinks.mailto].filter(Boolean).join("\n");
}
