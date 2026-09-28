import type { Product, ProductSearchQuery } from "./types";

/**
 * What a business's catalog can actually be searched BY, as reported by
 * its commerce provider. It is the vocabulary the model maps a customer's
 * words onto ("שחורה" / "blk" / "black-ish" -> color: "black"), and the
 * reference BARRY grounds every structured search field against. It says
 * nothing about what kind of business this is — the provider fills it.
 */
export type CatalogFacet = { key: string; values: string[] };

export type CatalogSchema = {
  categories: string[];
  /** Product-level attributes that can be filtered on. */
  attributes: CatalogFacet[];
  /** Variant option keys (size, length, flavour, ...) and their values. */
  variantOptions: CatalogFacet[];
  /** ISO 4217 code prices are listed in. */
  currency: string;
  priceRange?: { min: number; max: number };
};

const MAX_FACET_VALUES = 40;

function addValue(map: Map<string, Set<string>>, key: string, value: unknown): void {
  if (typeof value !== "string" || !value.trim()) return;
  const set = map.get(key) ?? new Set<string>();
  if (set.size < MAX_FACET_VALUES) set.add(value);
  map.set(key, set);
}

function toFacets(map: Map<string, Set<string>>): CatalogFacet[] {
  return [...map.entries()].map(([key, values]) => ({ key, values: [...values] })).sort((a, b) => a.key.localeCompare(b.key));
}

/** Derive the schema from a product list (used by providers that hold the catalog themselves). */
export function deriveCatalogSchema(products: Product[], fallbackCurrency = "ILS"): CatalogSchema {
  const categories = new Set<string>();
  const attributes = new Map<string, Set<string>>();
  const options = new Map<string, Set<string>>();
  const currencies = new Map<string, number>();
  let min = Infinity;
  let max = -Infinity;
  for (const product of products) {
    if (product.category) categories.add(product.category);
    for (const [key, value] of Object.entries(product.attributes)) {
      for (const v of Array.isArray(value) ? value : [value]) addValue(attributes, key, v);
    }
    for (const variant of product.variants) {
      for (const [key, value] of Object.entries(variant.options)) addValue(options, key, value);
      const code = variant.price.currency.toUpperCase();
      currencies.set(code, (currencies.get(code) ?? 0) + 1);
      min = Math.min(min, variant.price.amount);
      max = Math.max(max, variant.price.amount);
    }
  }
  const currency = [...currencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallbackCurrency;
  return {
    categories: [...categories].sort(),
    attributes: toFacets(attributes),
    variantOptions: toFacets(options),
    currency,
    ...(Number.isFinite(min) ? { priceRange: { min, max } } : {}),
  };
}

const fold = (s: string) => s.normalize("NFKC").trim().toLowerCase();

function findKey(facets: CatalogFacet[], key: string): CatalogFacet | undefined {
  return facets.find((f) => fold(f.key) === fold(key));
}

function canonicalValue(facet: CatalogFacet, value: string): string | undefined {
  if (facet.values.length === 0) return value.trim();
  return facet.values.find((v) => fold(v) === fold(value));
}

/** Unambiguous symbols and widely used non-ISO codes that name exactly one currency. */
const CURRENCY_ALIASES: Record<string, string> = { "₪": "ILS", "€": "EUR", NIS: "ILS" };
let isoCodes: Set<string> | undefined;

/** ISO 4217 code, or an unambiguous alias, to its ISO code. Anything else is not guessed. */
export function normalizeCurrency(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const upper = trimmed.toUpperCase();
  if (CURRENCY_ALIASES[trimmed] ?? CURRENCY_ALIASES[upper]) return CURRENCY_ALIASES[trimmed] ?? CURRENCY_ALIASES[upper];
  if (!/^[A-Z]{3}$/.test(upper)) return undefined;
  isoCodes ??= new Set(Intl.supportedValuesOf("currency"));
  return isoCodes.has(upper) ? upper : undefined;
}

export type CatalogRejection = { field: string; value: unknown; reason: string };

export type StructuredSearch = {
  category?: string;
  attributes?: Record<string, string>;
  options?: Record<string, string>;
  budget?: { amount: number; currency?: string };
};

/**
 * Ground structured search fields against the provider's schema:
 * canonicalise keys/values the catalog really has, move a variant-option
 * key that arrived as an attribute to options (a structural key match),
 * fill a missing budget currency with the catalog's own, and reject
 * everything else with a reason. Never invents a value.
 */
export function groundStructuredSearch(schema: CatalogSchema, input: StructuredSearch): { search: StructuredSearch; rejected: CatalogRejection[] } {
  const rejected: CatalogRejection[] = [];
  const search: StructuredSearch = {};

  if (input.category !== undefined) {
    const category = schema.categories.find((c) => fold(c) === fold(input.category!));
    if (category) search.category = category;
    else rejected.push({ field: "category", value: input.category, reason: "not a catalog category" });
  }

  const options: Record<string, string> = {};
  const addOption = (field: string, key: string, value: string) => {
    const facet = findKey(schema.variantOptions, key);
    const canonical = facet ? canonicalValue(facet, value) : undefined;
    if (!facet) rejected.push({ field, value, reason: "not a variant option of this catalog" });
    else if (!canonical) rejected.push({ field, value, reason: `"${value}" is not an offered ${facet.key}` });
    else options[facet.key] = canonical;
  };

  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.attributes ?? {})) {
    const field = `attributes.${key}`;
    if (typeof value !== "string" || !value.trim()) continue;
    const facet = findKey(schema.attributes, key);
    if (facet) {
      const canonical = canonicalValue(facet, value);
      if (canonical) attributes[facet.key] = canonical;
      else rejected.push({ field, value, reason: `"${value}" is not an offered ${facet.key}` });
    } else if (findKey(schema.variantOptions, key)) {
      addOption(field, key, value);
    } else {
      rejected.push({ field, value, reason: "not a searchable attribute of this catalog" });
    }
  }
  for (const [key, value] of Object.entries(input.options ?? {})) {
    if (typeof value === "string" && value.trim()) addOption(`options.${key}`, key, value);
  }
  if (Object.keys(attributes).length > 0) search.attributes = attributes;
  if (Object.keys(options).length > 0) search.options = options;

  if (input.budget) {
    const currency = input.budget.currency === undefined ? schema.currency : normalizeCurrency(input.budget.currency);
    if (!(input.budget.amount > 0)) rejected.push({ field: "budget", value: input.budget, reason: "not a positive amount" });
    else if (!currency) rejected.push({ field: "budget", value: input.budget, reason: "unrecognised currency" });
    else search.budget = { amount: input.budget.amount, currency };
  }
  return { search, rejected };
}

/** Defense in depth for any caller: the provider only ever sees fields its schema has. */
/** A search as callers state it: the budget currency may be left to the catalog. */
export type SearchRequest = Omit<ProductSearchQuery, "budget"> & { budget?: { amount: number; currency?: string } };

export function groundSearchQuery(schema: CatalogSchema, query: SearchRequest): { query: ProductSearchQuery; rejected: CatalogRejection[] } {
  const { search, rejected } = groundStructuredSearch(schema, query);
  return {
    query: {
      text: query.text?.trim() || undefined,
      ...search,
      budget: search.budget ? { amount: search.budget.amount, currency: search.budget.currency ?? schema.currency } : undefined,
    },
    rejected,
  };
}

/** Compact form for the model's context: enough to map words onto real values, bounded in size. */
export function catalogForModel(schema: CatalogSchema) {
  const cap = (values: string[]) => values.slice(0, 25);
  return {
    categories: schema.categories.slice(0, 40),
    attributes: schema.attributes.slice(0, 20).map((f) => ({ key: f.key, values: cap(f.values) })),
    variantOptions: schema.variantOptions.slice(0, 10).map((f) => ({ key: f.key, values: cap(f.values) })),
    currency: schema.currency,
    priceRange: schema.priceRange ?? null,
  };
}
