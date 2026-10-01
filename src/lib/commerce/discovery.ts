import type { CatalogSchema } from "./catalog";
import { groundStructuredSearch, type CatalogRejection, type StructuredSearch } from "./catalog";
import type { Product, ProductVariant } from "./types";

/**
 * PRODUCT DISCOVERY + GUIDED SELLING + ALTERNATIVES — pure helpers over the provider's own catalog
 * schema and products. Facets the catalog does not have are rejected (or remapped when the key is a
 * structural match), never invented. A shortlist is a small, grounded set the customer can compare
 * on attributes the catalog really states; alternatives are real in-stock variants or items with a
 * grounded reason. No fit / material / style claim is ever generated here.
 */

export type DiscoveryNeed = StructuredSearch & { text?: string; occasion?: string };

/** Ground a natural-language need's structured parts: occasion/budget/options against the schema. */
export function groundDiscovery(schema: CatalogSchema, need: DiscoveryNeed): { search: StructuredSearch & { text?: string }; rejected: CatalogRejection[] } {
  const attributes = { ...(need.attributes ?? {}) };
  // "occasion" is only a facet when the catalog lists it; otherwise it is kept as text for the search.
  if (need.occasion) attributes.occasion = need.occasion;
  const { search, rejected } = groundStructuredSearch(schema, { category: need.category, attributes, options: need.options, budget: need.budget });
  const occasionRejected = rejected.find((r) => r.field === "attributes.occasion");
  const text = [need.text, occasionRejected ? need.occasion : undefined].filter(Boolean).join(" ").trim() || undefined;
  return { search: { ...search, ...(text ? { text } : {}) }, rejected: rejected.filter((r) => r !== occasionRejected) };
}

export type ShortlistRow = { productId: string; title: string; price: { amount: number; currency: string }; inStockOptions: Record<string, string>[]; attributes: Record<string, string>; matchesBudget: boolean | null; matchesOptions: boolean };

const flat = (attrs: Product["attributes"]): Record<string, string> => Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== "keywords").map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]));
const inStock = (v: ProductVariant, qty = 1) => v.inventory.available >= qty;
const matchesOptions = (v: ProductVariant, options?: Record<string, string>) => !options || Object.entries(options).every(([k, val]) => (v.options[k] ?? "").toLowerCase() === val.toLowerCase());

/** A small grounded set to compare: in stock, within budget, matching the requested options first. */
export function shortlist(products: Product[], need: { budget?: { amount: number; currency: string }; options?: Record<string, string>; max?: number }): ShortlistRow[] {
  const rows: ShortlistRow[] = [];
  for (const p of products) {
    const stock = p.variants.filter((v) => inStock(v));
    if (stock.length === 0) continue;
    const cheapest = [...stock].sort((a, b) => a.price.amount - b.price.amount)[0];
    const budgetOk = need.budget ? (cheapest.price.currency === need.budget.currency ? cheapest.price.amount <= need.budget.amount : null) : null;
    if (budgetOk === false) continue;
    rows.push({ productId: p.id, title: p.title, price: cheapest.price, inStockOptions: stock.map((v) => v.options), attributes: flat(p.attributes), matchesBudget: budgetOk, matchesOptions: stock.some((v) => matchesOptions(v, need.options)) });
  }
  return rows.sort((a, b) => Number(b.matchesOptions) - Number(a.matchesOptions) || a.price.amount - b.price.amount).slice(0, need.max ?? 3);
}

/** Compare rows on the attributes they really share (keys present on every row). */
export function compareRows(rows: ShortlistRow[]): { keys: string[]; rows: { title: string; values: string[] }[] } {
  const keys = rows.length ? Object.keys(rows[0].attributes).filter((k) => rows.every((r) => k in r.attributes)) : [];
  return { keys, rows: rows.map((r) => ({ title: r.title, values: keys.map((k) => r.attributes[k]) })) };
}

export type Alternative = { productId: string; title: string; variant?: Record<string, string>; price: { amount: number; currency: string }; reason: string };

/**
 * Real alternatives for a desired item/variant that is not available: the same item in another
 * in-stock option, then other in-stock items of the same category near the price. Reasons are
 * grounded in stock and price only.
 */
export function alternativesFor(products: Product[], desired: { productId: string; options?: Record<string, string>; quantity?: number }, max = 3): Alternative[] {
  const qty = desired.quantity ?? 1;
  const product = products.find((p) => p.id === desired.productId);
  const out: Alternative[] = [];
  if (product) {
    const differing = Object.keys(desired.options ?? {});
    for (const v of product.variants.filter((v) => inStock(v, qty) && !matchesOptions(v, desired.options))) {
      const diff = differing.filter((k) => (v.options[k] ?? "") !== (desired.options?.[k] ?? "")).map((k) => `${k} ${v.options[k]}`);
      out.push({ productId: product.id, title: product.title, variant: v.options, price: v.price, reason: `${product.title} is in stock in ${diff.join(", ") || Object.entries(v.options).map(([k, val]) => `${k} ${val}`).join(", ")}` });
    }
  }
  const ref = product?.variants[0]?.price;
  for (const p of products) {
    if (out.length >= max) break;
    if (!product || p.id === product.id || p.category !== product.category) continue;
    const v = p.variants.filter((x) => inStock(x, qty)).find((x) => matchesOptions(x, desired.options)) ?? p.variants.find((x) => inStock(x, qty));
    if (!v) continue;
    const near = ref && v.price.currency === ref.currency ? Math.abs(v.price.amount - ref.amount) <= ref.amount * 0.25 : false;
    out.push({ productId: p.id, title: p.title, variant: v.options, price: v.price, reason: `${p.title} (same category) is in stock${matchesOptions(v, desired.options) && desired.options && Object.keys(desired.options).length ? ` in ${Object.entries(desired.options).map(([k, val]) => `${k} ${val}`).join(", ")}` : ""}${near ? " at a similar price" : ""}` });
  }
  return out.slice(0, max);
}
