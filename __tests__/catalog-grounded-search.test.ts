import { afterEach, describe, expect, it } from "vitest";
import { handleCustomerMessage } from "@/lib/runtime";
import { buildFashionRetailerGraph, fashionCatalog } from "@/lib/fixtures/fashion-retailer";
import { MockReasoner, setReasonerForTests, type BarryIR, type Reasoner } from "@/lib/reasoner";
import { OpenAIReasoner } from "@/lib/reasoner/openai-reasoner";
import { verifyIR } from "@/lib/reasoner/verify";
import { createInitialConversationState } from "@/lib/state";
import { MemoryCommerceAdapter } from "@/lib/commerce/adapters/memory";
import { CustomCommerceAdapter } from "@/lib/commerce/adapters/custom";
import { deriveCatalogSchema, groundStructuredSearch, normalizeCurrency } from "@/lib/commerce/catalog";
import { searchCommerceProducts } from "@/lib/commerce/capability";
import { resolveCommerceAdapterForBusiness } from "@/lib/commerce/registry";
import type { CommerceSemantics } from "@/lib/reasoner/ir";
import type { Product } from "@/lib/commerce/types";
import { ScriptedReasoner } from "./support/semantic-corpus";

/**
 * Live post-migration smoke failure: for
 *   "היי אני מחפשת שמלה שחורה מידה M לחתונה עד 400 שקל"
 * the live model produced attributes { price: "400 שקל" } + budgetAmount 400
 * and no size/color/occasion. The provider exact-filtered the unknown
 * "price" attribute and eliminated every product, although Onyx Slip
 * Dress in M exists at 390 ILS. Fix: the provider publishes its catalog
 * schema, the model maps words onto it, grounding rejects fields the
 * catalog doesn't have, and free text never vetoes a structured match.
 */

const SENTENCE = "היי אני מחפשת שמלה שחורה מידה M לחתונה עד 400 שקל";
const ONYX = "prod-onyx-slip-dress";
const MIDNIGHT = "prod-midnight-wrap-dress";

const search = (c: Omit<CommerceSemantics, "intent">): Partial<BarryIR> => ({ intent: "commerce_search", commerce: { intent: "search", ...c } });

/** What a competent model emits once it can see the catalog schema. */
const IDEAL = (text: string, currency: string | undefined = "ILS") =>
  search({
    query: { text, category: "dress", attributes: { color: "black", occasion: "wedding" }, budget: { amount: 400, currency } },
    variant: { size: "M" },
  });

async function runSearch(text: string, reasoner: Reasoner) {
  setReasonerForTests(reasoner);
  const graph = buildFashionRetailerGraph();
  const conv = `catalog-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const out = await handleCustomerMessage(graph, conv, `c-${conv}`, text);
  const products = ((out.turn.toolResult?.output as { products?: Product[] } | undefined)?.products ?? []).map((p) => p.id);
  return { graph, conv, out, products };
}

function expectOnyxInM(r: Awaited<ReturnType<typeof runSearch>>) {
  expect(r.out.turn.selectedAction?.name).toBe("searchProducts");
  expect(r.products[0]).toBe(ONYX);
  expect(r.products).not.toContain(MIDNIGHT); // 420 ILS is over the 400 budget
  const card = r.out.rich?.products?.[0];
  expect(card).toMatchObject({ title: "Onyx Slip Dress", price: "390 ILS" });
  expect(card?.availability).toMatch(/M/);
  expect(card?.availability).not.toMatch(/out of stock/i);
}

afterEach(() => setReasonerForTests(undefined));

describe("the exact live failure", () => {
  it("the live model's real output (price filed as an attribute, no size/color) now finds Onyx in M", async () => {
    const liveIr = search({ query: { text: SENTENCE, attributes: { price: "400 שקל" }, budget: { amount: 400 } } });
    const r = await runSearch(SENTENCE, new ScriptedReasoner({ [SENTENCE]: liveIr }));
    expect(r.products[0]).toBe(ONYX);
    expect(r.products).not.toContain(MIDNIGHT);
    expect(r.out.turn.selectedAction?.input).not.toHaveProperty("attributes.price");
    // Onyx's only in-stock variant is M, and it is shown as available.
    expect(r.out.rich?.products?.[0]).toMatchObject({ title: "Onyx Slip Dress", price: "390 ILS" });
  });

  it("the unsupported field is recorded as a grounding rejection, the rest of the search survives", () => {
    const graph = buildFashionRetailerGraph();
    const catalog = deriveCatalogSchema(fashionCatalog());
    const { verified, verification } = verifyIR(
      graph,
      SENTENCE,
      { intent: "commerce_search", entities: {}, constraints: {}, customerInfo: {}, commerce: { intent: "search", query: { text: SENTENCE, attributes: { price: "400 שקל" }, budget: { amount: 400 } } } },
      createInitialConversationState("x", graph.business.id, "c"),
      { catalog }
    );
    expect(verification.rejected).toContainEqual({ claim: "commerce.query.attributes.price", value: "400 שקל", reason: "not a searchable attribute of this catalog" });
    expect(verified.commerce?.query).toMatchObject({ text: SENTENCE, budget: { amount: 400, currency: "ILS" } });
    expect(verified.commerce?.query?.attributes).toBeUndefined();
  });

  it("the offline stand-in also finds Onyx in M for the exact sentence", async () => {
    expectOnyxInM(await runSearch(SENTENCE, new MockReasoner()));
  });

  it("choosing it afterwards puts Onyx in M into the provider cart", async () => {
    const r = await runSearch(SENTENCE, new ScriptedReasoner({ [SENTENCE]: IDEAL(SENTENCE), "אקח אותה במידה M": { intent: "commerce_select", commerce: { intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } } } }));
    const take = await handleCustomerMessage(r.graph, r.conv, `c-${r.conv}`, "אקח אותה במידה M");
    expect(take.turn.toolResult?.output).toMatchObject({ added: true });
    const cart = await (await resolveCommerceAdapterForBusiness(r.graph.business.id)).getCart(take.state.knownFields.__commerceCartId);
    expect(cart?.lines.map((l) => [l.productId, l.options.size, l.unitPrice.amount])).toEqual([[ONYX, "M", 390]]);
  });
});

/** Same need, different words: the model maps each onto the same catalog values. */
const MULTILINGUAL: { name: string; text: string; currency?: string }[] = [
  { name: "exact sentence", text: SENTENCE },
  { name: "Hebrew typos", text: "היי אני מחפשת שמלה שחרוה מדה M לחתנוה עד 400 שח" },
  { name: "Hebrew slang", text: "אחי יש לכם שמלה שחורה במ' לחתונה עד 400 שקל?" },
  { name: "English", text: "hi, looking for a black dress size M for a wedding, max 400 shekels" },
  { name: "English typos/slang", text: "yo need a blak dres sz medium 4 a weding, under 400 nis", currency: "NIS" },
  { name: "Mixed Hebrew/English", text: "black dress מידה M לחתונה עד ₪400", currency: "₪" },
  { name: "Russian", text: "ищу чёрное платье размер M на свадьбу до 400 шекелей" },
  { name: "Arabic", text: "بدي فستان أسود مقاس M لعرس لحد 400 شيكل" },
  { name: "no currency named", text: "שמלה שחורה M לחתונה עד 400", currency: undefined },
];

describe("multilingual, typo and slang paraphrases reach Onyx in M (model output through real grounding + provider)", () => {
  it.each(MULTILINGUAL.map((c) => [c.name, c]))("%s", async (_n, c) => {
    const currency = "currency" in c ? c.currency : "ILS";
    expectOnyxInM(await runSearch(c.text, new ScriptedReasoner({ [c.text]: IDEAL(c.text, currency) })));
  });
});

describe("imperfect model shapes are grounded, not trusted and not fatal", () => {
  const cases: [string, Partial<BarryIR>][] = [
    ["size filed as an attribute, lower-case", search({ query: { text: SENTENCE, attributes: { size: "m", color: "black" }, budget: { amount: 400 } } })],
    ["attribute key/value casing differs", search({ query: { text: SENTENCE, attributes: { Color: "BLACK" }, budget: { amount: 400, currency: "ils" } }, variant: { Size: "m" } })],
    ["untranslated attribute value", search({ query: { text: SENTENCE, attributes: { color: "שחורה" }, budget: { amount: 400 } }, variant: { size: "M" } })],
    ["category not in the catalog", search({ query: { text: SENTENCE, category: "Evening Dresses", budget: { amount: 400 } }, variant: { size: "M" } })],
    ["invented attribute key", search({ query: { text: SENTENCE, attributes: { vibe: "elegant", color: "black" }, budget: { amount: 400 } }, variant: { size: "M" } })],
    ["text-only words that match nothing", search({ query: { text: "היי אני מחפשת משהו ממש יפה", attributes: { color: "black" }, budget: { amount: 400 } }, variant: { size: "M" } })],
  ];
  it.each(cases)("%s", async (_n, ir) => {
    const text = `${_n} :: ${SENTENCE}`;
    expectOnyxInM(await runSearch(text, new ScriptedReasoner({ [text]: ir })));
  });

  it("an unrecognisable currency is rejected, never guessed", () => {
    const schema = deriveCatalogSchema(fashionCatalog());
    const { search: s, rejected } = groundStructuredSearch(schema, { budget: { amount: 400, currency: "שקל" } });
    expect(s.budget).toBeUndefined();
    expect(rejected).toEqual([{ field: "budget", value: { amount: 400, currency: "שקל" }, reason: "unrecognised currency" }]);
  });

  it("an offered value outside the catalog is rejected with a reason, and an option key moves to options", () => {
    const schema = deriveCatalogSchema(fashionCatalog());
    const { search: s, rejected } = groundStructuredSearch(schema, { attributes: { size: "m", color: "charcoal" } });
    expect(s.options).toEqual({ size: "M" });
    expect(rejected).toEqual([{ field: "attributes.color", value: "charcoal", reason: '"charcoal" is not an offered color' }]);
  });
});

describe("currency normalisation", () => {
  it.each([
    ["ILS", "ILS"],
    ["ils", "ILS"],
    ["₪", "ILS"],
    ["NIS", "ILS"],
    ["usd", "USD"],
    ["€", "EUR"],
    ["$", undefined],
    ["שקל", undefined],
    ["XYZ", undefined],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeCurrency(input)).toBe(expected);
  });
});

describe("the provider publishes, and only ever receives, its own schema", () => {
  it("the memory provider describes its catalog", async () => {
    const schema = await new MemoryCommerceAdapter(fashionCatalog()).describeCatalog();
    expect(schema.currency).toBe("ILS");
    expect(schema.categories).toEqual(["accessory", "dress"]);
    expect(schema.variantOptions.map((f) => f.key)).toEqual(["color", "size"]);
    expect(schema.variantOptions.find((f) => f.key === "size")?.values).toEqual(expect.arrayContaining(["S", "M", "L"]));
    expect(schema.attributes.find((f) => f.key === "color")?.values).toEqual(["black"]);
    expect(schema.priceRange).toEqual({ min: 90, max: 420 });
  });

  it("structured filters are exact and free text never vetoes them", async () => {
    const adapter = new MemoryCommerceAdapter(fashionCatalog());
    const { products } = await adapter.searchProducts({ text: "זקוקה למשהו בלי קשר בכלל", options: { size: "M" }, budget: { amount: 400, currency: "ILS" } });
    expect(products.map((p) => p.id)).toEqual([ONYX]);
    const textOnly = await adapter.searchProducts({ text: "זקוקה למשהו בלי קשר בכלל" });
    expect(textOnly.products).toEqual([]);
  });

  it("a budget applies to the SAME variant that satisfies the options", async () => {
    const adapter = new MemoryCommerceAdapter([
      {
        ...fashionCatalog()[0],
        id: "p-split",
        variants: [
          { id: "v-cheap-s", sku: "a", title: "S", options: { size: "S" }, price: { amount: 100, currency: "ILS" }, inventory: { available: 5 } },
          { id: "v-dear-m", sku: "b", title: "M", options: { size: "M" }, price: { amount: 900, currency: "ILS" }, inventory: { available: 5 } },
        ],
      },
    ]);
    expect((await adapter.searchProducts({ options: { size: "M" }, budget: { amount: 400, currency: "ILS" } })).products).toEqual([]);
  });

  it("an external provider's schema is validated, and its search never receives fields outside it", async () => {
    const requests: string[] = [];
    const fetcher = (async (url: RequestInfo | URL) => {
      const u = new URL(String(url));
      requests.push(u.pathname + u.search);
      if (u.pathname === "/catalog/schema") {
        return Response.json({ categories: ["dress"], attributes: [{ key: "color", values: ["black"] }], variantOptions: [{ key: "size", values: ["M"] }], currency: "ils" });
      }
      return Response.json({ products: [] });
    }) as typeof fetch;
    const adapter = new CustomCommerceAdapter({ baseUrl: "https://shop.example.test" }, { apiKey: "k" }, fetcher);
    expect((await adapter.describeCatalog()).currency).toBe("ILS");

    const bad = new CustomCommerceAdapter({ baseUrl: "https://shop.example.test" }, { apiKey: "k" }, (async () => Response.json({ categories: "nope" })) as typeof fetch);
    await expect(bad.describeCatalog()).rejects.toThrow(/invalid catalog schema/);
    const noIso = new CustomCommerceAdapter({ baseUrl: "https://shop.example.test" }, { apiKey: "k" }, (async () => Response.json({ categories: [], attributes: [], variantOptions: [], currency: "shekels" })) as typeof fetch);
    await expect(noIso.describeCatalog()).rejects.toThrow(/ISO 4217/);
  });

  it("the capability layer re-grounds any caller's query against the schema before the provider sees it", async () => {
    const graph = buildFashionRetailerGraph();
    const result = await searchCommerceProducts(graph, { text: SENTENCE, attributes: { price: "400 שקל" }, budget: { amount: 400 } });
    expect(result.query).toEqual({ text: SENTENCE, budget: { amount: 400, currency: "ILS" } });
    expect(result.dropped).toEqual([{ field: "attributes.price", value: "400 שקל", reason: "not a searchable attribute of this catalog" }]);
    expect(result.products[0].id).toBe(ONYX);
  });
});

describe("universality: the same grounding serves any catalog", () => {
  const bakery: Product[] = [
    {
      id: "cake-1",
      title: "Lemon Cake",
      description: "Bright citrus sponge.",
      category: "cake",
      attributes: { flavor: "lemon", diet: ["vegan"] },
      media: [],
      variants: [
        { id: "c1-8", sku: "LC8", title: "8 servings", options: { servings: "8" }, price: { amount: 180, currency: "EUR" }, inventory: { available: 2 } },
        { id: "c1-16", sku: "LC16", title: "16 servings", options: { servings: "16" }, price: { amount: 320, currency: "EUR" }, inventory: { available: 0 } },
      ],
    },
    {
      id: "cake-2",
      title: "Chocolate Cake",
      description: "Dark and rich.",
      category: "cake",
      attributes: { flavor: "chocolate", diet: [] },
      media: [],
      variants: [{ id: "c2-8", sku: "CC8", title: "8 servings", options: { servings: "8" }, price: { amount: 150, currency: "EUR" }, inventory: { available: 4 } }],
    },
  ];

  it("grounds a different vocabulary and currency with no code changes", async () => {
    const schema = deriveCatalogSchema(bakery);
    expect(schema.currency).toBe("EUR");
    const { search: s, rejected } = groundStructuredSearch(schema, { category: "Cake", attributes: { Diet: "Vegan", size: "large" }, options: { servings: "8" }, budget: { amount: 200, currency: "€" } });
    expect(s).toEqual({ category: "cake", attributes: { diet: "vegan" }, options: { servings: "8" }, budget: { amount: 200, currency: "EUR" } });
    expect(rejected).toEqual([{ field: "attributes.size", value: "large", reason: "not a searchable attribute of this catalog" }]);
    const { products } = await new MemoryCommerceAdapter(bakery).searchProducts({ ...s, budget: s.budget as { amount: number; currency: string }, text: "bday cake pls" });
    expect(products.map((p) => p.id)).toEqual(["cake-1"]);
  });
});

const LIVE = Boolean(process.env.OPENAI_API_KEY && process.env.BARRY_LIVE_EVAL === "1");

describe.skipIf(!LIVE)("LIVE model: the catalog-grounded search finds Onyx in M (BARRY_LIVE_EVAL=1)", () => {
  it.each(MULTILINGUAL.map((c) => [c.name, c.text]))("%s", async (_n, text) => {
    expectOnyxInM(await runSearch(text, new OpenAIReasoner()));
  }, 60_000);
});
