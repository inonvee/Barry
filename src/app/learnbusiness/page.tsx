import { analyzeApprovedSources, readinessReport } from "@/lib/learn-business/pipeline";

export default async function LearnBusinessPage() {
  const analysis = await analyzeApprovedSources({
    businessId: "fashion-retailer",
    sources: [
      {
        url: "https://example.com/shipping",
        html: `
          <h1>Shipping and Returns</h1>
          <p>Free shipping above ₪399.</p>
          <p>Returns are accepted within 14 days. Sale items can be exchanged only.</p>
          <p>Evening wear and occasion dresses.</p>
        `,
      },
    ],
  });
  const readiness = readinessReport(analysis, {
    connections: [{ capability: "commerce", status: "connected" }],
  });

  return (
    <main className="min-h-screen bg-[#f7f7f4] px-5 py-8 text-[#171717]">
      <section className="mx-auto max-w-6xl">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-[#667085]">Train Barry</p>
        <h1 className="mt-3 text-3xl font-semibold">Business learning workspace</h1>
        <p className="mt-3 max-w-2xl text-base text-[#475467]">
          Barry learns from approved sources, separates facts from inferences, and asks only for the operating answers it still needs.
        </p>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-[#d0d5dd] bg-white p-5">
            <div className="text-sm text-[#667085]">Website analyzed</div>
            <div className="mt-2 text-2xl font-semibold">{analysis.sanitizedSourceCount}</div>
          </div>
          <div className="rounded-lg border border-[#d0d5dd] bg-white p-5">
            <div className="text-sm text-[#667085]">Facts and inferences</div>
            <div className="mt-2 text-2xl font-semibold">{analysis.facts.length}</div>
          </div>
          <div className="rounded-lg border border-[#d0d5dd] bg-white p-5">
            <div className="text-sm text-[#667085]">Operational state</div>
            <div className="mt-2 text-2xl font-semibold capitalize">{readiness.operational.state}</div>
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <section className="rounded-lg border border-[#d0d5dd] bg-white p-5">
            <h2 className="text-lg font-semibold">What Barry learned</h2>
            <div className="mt-4 divide-y divide-[#eaecf0]">
              {analysis.facts.map((fact) => (
                <div key={fact.key} className="grid gap-2 py-4 md:grid-cols-[1fr_1fr_120px]">
                  <div>
                    <div className="font-medium">{fact.key}</div>
                    <div className="text-sm text-[#667085]">{fact.source.url}</div>
                  </div>
                  <div>{fact.value}</div>
                  <div className="text-sm capitalize text-[#475467]">{fact.classification}</div>
                </div>
              ))}
            </div>
          </section>

          <aside className="rounded-lg border border-[#d0d5dd] bg-white p-5">
            <h2 className="text-lg font-semibold">Missing answers</h2>
            <div className="mt-4 space-y-4">
              {analysis.questions.map((question) => (
                <div key={question.key} className="rounded-md bg-[#f9fafb] p-4">
                  <div className="font-medium">{question.question}</div>
                  <div className="mt-2 text-sm text-[#667085]">{question.reason}</div>
                  <div className="mt-3 text-xs uppercase tracking-[0.16em] text-[#667085]">{question.unlocksCapability}</div>
                </div>
              ))}
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
