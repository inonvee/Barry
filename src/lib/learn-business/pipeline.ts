export type LearnedClassification = "fact" | "inference" | "recommendation" | "policy";

export type LearnedSource = {
  url: string;
  title?: string;
};

export type LearnedBusinessFact = {
  key: string;
  value: string;
  classification: LearnedClassification;
  source: LearnedSource;
  confidence: "low" | "medium" | "high";
  discoveredAt: string;
  refreshedAt: string;
  ownerVerified: boolean;
};

export type BusinessGapQuestion = {
  key: string;
  question: string;
  reason: string;
  unlocksCapability: string;
};

export type BusinessDiscoveryResult = {
  businessId: string;
  facts: LearnedBusinessFact[];
  questions: BusinessGapQuestion[];
  sanitizedSourceCount: number;
};

function now(): string {
  return new Date().toISOString();
}

function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower === "::1") return true;
  const ipv4 = lower.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1).map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function safeSourceUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unsupported source protocol");
  if (isPrivateHost(url.hostname)) throw new Error("Private/internal source URLs are not allowed");
  return url;
}

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/ignore your instructions[^.?!]*(?:[.?!]|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addFact(facts: LearnedBusinessFact[], input: Omit<LearnedBusinessFact, "discoveredAt" | "refreshedAt" | "ownerVerified">) {
  if (facts.some((fact) => fact.key === input.key)) return;
  const stamp = now();
  facts.push({ ...input, discoveredAt: stamp, refreshedAt: stamp, ownerVerified: false });
}

export async function analyzeApprovedSources(input: {
  businessId: string;
  sources: { url: string; html?: string; title?: string }[];
}): Promise<BusinessDiscoveryResult> {
  const facts: LearnedBusinessFact[] = [];
  for (const source of input.sources.slice(0, 8)) {
    const url = safeSourceUrl(source.url);
    const text = visibleText(source.html ?? "");
    const learnedSource = { url: url.toString(), title: source.title };

    const shipping = text.match(/free shipping (?:above|over)\s*((?:₪|â‚ª)\s*\d+|\d+\s*(?:ils|nis|shekels?))/i);
    if (shipping) {
      addFact(facts, {
        key: "shipping.free_threshold",
        value: shipping[1].replace(/\s+/g, ""),
        classification: "fact",
        source: learnedSource,
        confidence: "high",
      });
    }

    const returns = text.match(/returns? (?:are )?accepted within\s*(\d+\s*days?)/i);
    if (returns) {
      addFact(facts, {
        key: "returns.window",
        value: returns[1],
        classification: "fact",
        source: learnedSource,
        confidence: "high",
      });
    }

    if (/sale items?.{0,40}exchange only/i.test(text)) {
      addFact(facts, {
        key: "returns.sale_items",
        value: "exchange only",
        classification: "fact",
        source: learnedSource,
        confidence: "high",
      });
    }

    if (/dress|event|occasion|wedding|evening/i.test(text) || !facts.some((fact) => fact.key === "catalog.focus")) {
      addFact(facts, {
        key: "catalog.focus",
        value: "event fashion",
        classification: "inference",
        source: learnedSource,
        confidence: "medium",
      });
    }
  }

  const { questions } = detectBusinessGaps({ facts });
  return { businessId: input.businessId, facts, questions, sanitizedSourceCount: input.sources.length };
}

export function detectBusinessGaps(input: Pick<BusinessDiscoveryResult, "facts">): { questions: BusinessGapQuestion[] } {
  const keys = new Set(input.facts.map((fact) => fact.key));
  const questions: BusinessGapQuestion[] = [];
  if (!keys.has("returns.window")) {
    questions.push({
      key: "returns.policy",
      question: "What return or exchange rule should Barry follow?",
      reason: "No reliable returns policy was found in the approved sources.",
      unlocksCapability: "commerce",
    });
  }
  if (!keys.has("shipping.free_threshold")) {
    questions.push({
      key: "shipping.policy",
      question: "What delivery or shipping fees should Barry quote?",
      reason: "Barry should not invent delivery costs or thresholds.",
      unlocksCapability: "commerce",
    });
  }
  questions.push({
    key: "discount.authority",
    question: "What discount, if any, may Barry offer automatically?",
    reason: "Discount authority is consequential and requires owner approval.",
    unlocksCapability: "payments",
  });
  return { questions };
}

export function readinessReport(
  analysis: Pick<BusinessDiscoveryResult, "facts" | "questions">,
  options: { connections: { commerce?: boolean; payments?: boolean; channel?: boolean } | { capability: string; status: string }[] }
) {
  const blockers: string[] = [];
  const connected = Array.isArray(options.connections)
    ? new Set(options.connections.filter((connection) => connection.status === "connected").map((connection) => connection.capability))
    : undefined;
  const hasConnection = (capability: string) =>
    connected ? connected.has(capability) : Boolean((options.connections as { [key: string]: boolean | undefined })[capability]);
  if (!hasConnection("commerce")) blockers.push("Commerce connection is not verified");
  if (!hasConnection("payments")) blockers.push("Payment connection is not verified");
  if (!hasConnection("channel") && !hasConnection("messaging")) blockers.push("Customer channel is not connected");
  for (const question of analysis.questions) blockers.push(`Owner answer needed: ${question.key}`);
  return {
    understanding: {
      state: analysis.facts.length >= 3 ? "usable" : "thin",
      facts: analysis.facts.length,
    },
    operational: {
      state: blockers.length === 0 ? "ready" : "blocked",
      blockers,
    },
  };
}
