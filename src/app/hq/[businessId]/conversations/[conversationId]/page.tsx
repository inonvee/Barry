import { notFound } from "next/navigation";
import { requireFounder } from "@/lib/hq/guard";
import { getHqConversation } from "@/lib/hq/service";
import { hqConversationView } from "@/lib/hq/conversation-view";
import { TurnView } from "@/components/InspectorPanel";
import { Badge, Card } from "@/components/hq/ui";
import { HqShell } from "@/components/hq/HqShell";
import { hqShellLight } from "@/lib/hq/shell-data";
import Link from "next/link";

export default async function HqConversationPage({ params }: { params: Promise<{ businessId: string; conversationId: string }> }) {
  await requireFounder();
  const { businessId, conversationId } = await params;
  const found = await getHqConversation(businessId, conversationId);
  if (!found) notFound();
  const conversation = hqConversationView(found.conversation);
  const turns = conversation.turns;

  return (
    <HqShell active="business" data={hqShellLight()}>
      <p className="mx-auto max-w-6xl px-4 pt-4 text-[12px] text-[#667085]"><Link href="/hq" className="hover:underline">Focus</Link> › <Link href={`/hq/${encodeURIComponent(found.business.id)}`} className="hover:underline">{found.business.name}</Link> › <Link href={`/hq/${encodeURIComponent(found.business.id)}?view=technical`} className="hover:underline">Technical</Link> › conversation</p>
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="break-all text-lg font-semibold">{conversation.id}</h1>
          <Badge>{conversation.stage}</Badge>
          <Badge>{conversation.outcome ?? "pending"}</Badge>
          <span className="text-xs text-neutral-500">{turns.length} turns · persisted trace</span>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <Card title="Messages">
            <ol className="space-y-2">
              {conversation.messages.map((m, i) => (
                <li key={i} className={`flex ${m.role === "customer" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
                      m.role === "customer" ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : "bg-neutral-100 dark:bg-neutral-800"
                    }`}
                  >
                    {m.content}
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          <div className="space-y-3">
            {turns.length === 0 && <Card title="Turns">No turns.</Card>}
            {turns.map((turn, i) => (
              <details key={turn.id} open={i === turns.length - 1} className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
                <summary className="cursor-pointer px-4 py-2 text-sm">
                  <span className="font-medium">Turn {i + 1}</span> <span className="text-neutral-500">— {turn.understood.intent}</span>
                  {turn.trace ? (
                    <span className="text-neutral-500"> · {turn.trace.steps.map((s) => s.action).join(" → ") || "no action"}</span>
                  ) : (
                    <span className="text-neutral-500"> · no trace (before 0011)</span>
                  )}
                </summary>
                <div className="space-y-3 p-3">
                  <TurnView state={conversation} turn={turn} isLatest={i === turns.length - 1} />
                </div>
              </details>
            ))}
          </div>
        </div>
      </main>
    </HqShell>
  );
}
