import { MockReasoner } from "@/lib/reasoner/mock-reasoner";
import type { BarryIR, ComposeResponseInput, Reasoner, ReasonerContext } from "@/lib/reasoner";
import type { CommerceSemantics } from "@/lib/reasoner/ir";

/**
 * Semantic evaluation corpus. Each group is ONE meaning expressed many
 * ways (Hebrew, English, slang, mixed). The `ir` is what a competent model
 * emits for that meaning — the model owns understanding; everything after
 * the IR (grounding, compilation, policy, provider execution) is BARRY's
 * and must turn every paraphrase into the SAME grounded outcome.
 *
 * The same corpus runs (a) with a scripted model through the real
 * pipeline, (b) with the offline stand-in for SAFETY only (it may not
 * understand, but must never do the wrong thing), and (c) against the
 * live model when BARRY_LIVE_EVAL=1 and OPENAI_API_KEY are set.
 */

export type Setup = "fresh" | "results" | "cart_first_L" | "cart_second_M" | "checkout";

export type ParaphraseGroup = {
  id: string;
  setup: Setup;
  meaning: string;
  ir: Partial<BarryIR>;
  paraphrases: { he: string[]; en: string[] };
};

const commerce = (c: CommerceSemantics): Partial<BarryIR> => ({ intent: `commerce_${c.intent}`, commerce: c });

export const SEMANTIC_GROUPS: ParaphraseGroup[] = [
  {
    id: "select_first_in_M",
    setup: "results",
    meaning: "Take the first shown result, size M",
    ir: commerce({ intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }),
    paraphrases: {
      he: [
        "יאללה אני אקח את הראשונה ב-M",
        "אני אקח את הראשונה במידה M",
        "תן לי את הראשונה במדיום",
        "אקח את הראשונה, מידה M",
        "הראשונה ב-M בבקשה",
        "שים לי את הראשונה במדיום",
        "בא לי את הראשונה ב-M",
        "סגור, הראשונה במידה בינונית",
        "אני הולכת על הראשונה, M",
        "את הראשונה ב M תודה",
      ],
      en: [
        "I'll take the first one in M",
        "first one, size medium please",
        "gimme the 1st in M",
        "let's go with the first, medium",
        "the first dress in a medium",
        "yeah the top one in M",
        "I want number one in size M",
        "put the first one in my cart, M",
        "ok first one - M",
        "#1 in medium please",
      ],
    },
  },
  {
    id: "select_second",
    setup: "results",
    meaning: "Take the second shown result",
    ir: commerce({ intent: "select", reference: { type: "previous_result", index: 1 } }),
    paraphrases: {
      he: ["יאללה את השנייה", "השנייה", "אני אקח את השנייה", "תביא את השנייה", "בא לי את השנייה"],
      en: ["the second one", "I'll take the 2nd", "option two please", "let's do the second", "number 2"],
    },
  },
  {
    id: "change_cart_item_to_M",
    setup: "cart_first_L",
    meaning: "Change the item in the cart to size M",
    ir: commerce({ intent: "change_variant", reference: { type: "cart_line", index: 0 }, variant: { size: "M" } }),
    paraphrases: {
      he: ["שים לי אותה במדיום", "תחליף למידה M", "עדיף M", "בעצם תעשה אותה M", "אפשר במקום זה במדיום?"],
      en: ["actually make it medium", "switch it to M", "can I get that in M instead", "size down to M", "change the size to medium"],
    },
  },
  {
    id: "replace_with_first",
    setup: "cart_second_M",
    meaning: "Swap the cart item for the first shown result",
    ir: commerce({ intent: "replace", reference: { type: "previous_result", index: 0 } }),
    paraphrases: {
      he: ["עזוב, תחליף לראשונה", "בעצם אני רוצה את הראשונה במקום", "תחליף אותה לראשונה", "לא, את הראשונה עדיף", "עזוב את זו, קח את הראשונה"],
      en: ["never mind, switch to the first one", "actually I want the first one instead", "swap it for the first", "no, the first one is better", "replace it with the first dress"],
    },
  },
  {
    id: "negotiate_350",
    setup: "cart_first_L",
    meaning: "Ask for a price of 350",
    ir: commerce({ intent: "negotiate_price", requestedPrice: { amount: 350 } }),
    paraphrases: {
      he: ["יש מצב 350?", "תעשה לי 350", "אפשר ב-350?", "מה דעתך על 350 שקל?", "תוריד ל350"],
      en: ["can you do 350?", "would you take 350", "350 and we have a deal?", "any chance for 350 shekels", "how about 350"],
    },
  },
  {
    id: "claims_paid",
    setup: "checkout",
    meaning: "Customer says they already paid (a claim)",
    ir: { intent: "payment_claim", customerClaims: { paymentCompleted: true } },
    paraphrases: {
      he: ["אחי שילמתי כבר", "שילמתי", "העברתי כבר את הכסף", "כבר שילמתי לך", "התשלום עבר"],
      en: ["I paid", "payment done", "just sent the money", "already paid bro", "it went through on my side"],
    },
  },
  {
    id: "search_black_dress",
    setup: "fresh",
    meaning: "Look for a black dress",
    ir: commerce({ intent: "search", query: { text: "black dress", category: "dress", attributes: { color: "black" } } }),
    paraphrases: {
      he: ["יש לכם שמלה שחורה?", "מחפשת שמלה שחורה לחתונה", "תראי לי שמלות שחורות"],
      en: ["got any black dresses?", "looking for a black dress for a wedding", "show me black dresses"],
    },
  },
  {
    // HEBREW COMMERCE SEMANTICS: one natural sentence carries category, colour, size, occasion and an ILS budget.
    // The MODEL maps the words; the pipeline must keep budget (ILS), the size option and the supported facets,
    // and reject nothing it can ground. Typo / slang variants are the same meaning.
    id: "search_black_dress_M_wedding_under_400",
    setup: "fresh",
    meaning: "A black dress, size M, for a wedding, up to ₪400",
    ir: commerce({ intent: "search", query: { text: "black dress wedding", category: "dress", attributes: { color: "black", occasion: "wedding" }, budget: { amount: 400, currency: "ILS" } }, variant: { size: "M" } }),
    paraphrases: {
      he: [
        "היי אני מחפשת שמלה שחורה מידה M לחתונה עד 400 שקל",
        "שמלה שחורה במידה M לחתונה, עד 400 ש\"ח",
        "מחפשת שמלה שחורה M לחתונה עד 400שח",
        "יש שמלה שחורה מידה מדיום לחתונה במקסימום 400?",
        "שמלה שחורה בM לחתונה, לא יותר מ-400 שקל",
      ],
      en: ["looking for a black dress, size M, for a wedding, under 400 shekels", "black dress in M for a wedding up to ₪400", "a black wedding-guest dress, medium, max 400 ILS"],
    },
  },
];

export const ALL_PARAPHRASES = SEMANTIC_GROUPS.flatMap((g) =>
  [...g.paraphrases.he.map((text) => ({ group: g, text, lang: "he" })), ...g.paraphrases.en.map((text) => ({ group: g, text, lang: "en" }))]
);

/** Scripted setup turns shared by every group. */
export const SETUP_SCRIPT: Record<string, Partial<BarryIR>> = {
  "__setup: search black dresses": commerce({ intent: "search", query: { text: "black dress", category: "dress", attributes: { color: "black" } } }),
  "__setup: first in L": commerce({ intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "L" } }),
  "__setup: second in M": commerce({ intent: "select", reference: { type: "previous_result", index: 1 }, variant: { size: "M" } }),
  "__setup: first in M": commerce({ intent: "select", reference: { type: "previous_result", index: 0 }, variant: { size: "M" } }),
  "__setup: checkout": commerce({ intent: "checkout" }),
  // The business needs name + phone before checkout; the model cites them from the message.
  "My name is Dana, phone 0501234567": {
    intent: "provide_details",
    customerInfo: { name: "Dana", phone: "0501234567" },
    evidence: { "customerInfo.name": "Dana", "customerInfo.phone": "0501234567" },
  },
  // What a model emits when BARRY asked "which size?" and the answer is "M".
  "__followup: M": commerce({ intent: "select", variant: { size: "M" } }),
};

export const SETUP_TURNS: Record<Setup, string[]> = {
  fresh: [],
  results: ["__setup: search black dresses"],
  cart_first_L: ["__setup: search black dresses", "__setup: first in L"],
  cart_second_M: ["__setup: search black dresses", "__setup: second in M"],
  checkout: ["__setup: search black dresses", "__setup: first in M", "__setup: checkout", "My name is Dana, phone 0501234567"],
};

/**
 * Plays the model: returns the scripted IR for known messages and defers
 * to the offline stand-in for anything else (e.g. "(payment received)").
 */
export class ScriptedReasoner implements Reasoner {
  readonly name = "llm" as const;
  private readonly fallback = new MockReasoner();
  constructor(private readonly script: Record<string, Partial<BarryIR>>) {}

  async understand(ctx: ReasonerContext): Promise<BarryIR> {
    const scripted = this.script[ctx.customerMessage];
    if (!scripted) return this.fallback.understand(ctx);
    return { intent: "scripted", entities: {}, constraints: {}, customerInfo: {}, ...structuredClone(scripted) } as BarryIR;
  }

  async composeResponse(ctx: ReasonerContext, input: ComposeResponseInput): Promise<string> {
    return this.fallback.composeResponse(ctx, input);
  }
}
