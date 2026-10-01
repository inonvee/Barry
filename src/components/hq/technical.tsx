import Link from "next/link";
import type { HqBusinessDetail } from "@/lib/hq/service";
import { Badge, Card, Kv, WithSource, label, statusTone } from "@/components/hq/ui";

/**
 * TECHNICAL VIEW of one business — genome, capability surface, connections, recent turns, records.
 * Raw ids and ISO instants are allowed here (and only here). Served under Business focus › Technical.
 */
const when = (iso: string | null) => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) : "—");

export function TechnicalView({ b }: { b: HqBusinessDetail }) {
  const convoHref = (id: string) => `/hq/${encodeURIComponent(b.id)}/conversations/${encodeURIComponent(id)}`;
  return (
    <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Readiness (same as Learn Business)">
            <WithSource value={b.readiness}>
              {(r) => (
                <>
                  <Kv k="Understanding" v={<Badge tone={statusTone(r.understanding.state)}>{label(r.understanding.state)}</Badge>} />
                  <Kv k="Requirements met" v={`${r.understanding.requirementsMet} / ${r.understanding.requirementsTotal}`} />
                  <Kv k="Facts verified / to review" v={`${r.understanding.verifiedFacts} / ${r.understanding.candidateFacts}`} />
                  <ul className="mt-2 space-y-1.5 text-sm">
                    {r.operational.blockers.map((x, i) => (
                      <li key={i}>
                        <Badge tone="warn">{x.capability}</Badge> {x.reason} <span className="text-neutral-500">— {x.fix}</span>
                      </li>
                    ))}
                    {r.operational.blockers.length === 0 && <li className="text-neutral-500">No blockers.</li>}
                  </ul>
                </>
              )}
            </WithSource>
          </Card>

          <Card title="What BARRY can operate">
            <WithSource value={b.capabilities}>
              {(caps) => (
                <ul className="space-y-2 text-sm">
                  {caps.map((c) => (
                    <li key={c.capability}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{c.capability}</span>
                        <Badge tone={statusTone(c.status)}>{label(c.status)}</Badge>
                        {c.provider && <span className="text-xs text-neutral-500">{c.provider}</span>}
                      </div>
                      {c.canDo.length > 0 && <p className="text-xs text-neutral-600 dark:text-neutral-400">Can: {c.canDo.join(", ")}</p>}
                      {c.needed && c.cannotDo.length > 0 && <p className="text-xs text-neutral-500">Cannot: {c.cannotDo.join(", ")}</p>}
                      {c.unlock && <p className="text-xs text-amber-700 dark:text-amber-400">{c.unlock}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </WithSource>
          </Card>
        </div>

        <Card title="What BARRY can do for this business (owner's Train BARRY view)">
          <WithSource value={b.assessment}>
            {(a) => (
              <>
                <ul className="space-y-1 text-sm">
                  {a.needs.map((n) => (
                    <li key={n.id} className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={n.status === "ready" ? "good" : n.status === "ready_simulated" ? "warn" : "bad"}>{label(n.status)}</Badge>
                      <span className="font-medium">{n.title}</span>
                      <span className="text-xs text-neutral-500">{n.authority === "read" ? "read" : label(n.authority)}{n.provider ? ` · ${n.provider}` : ""}</span>
                    </li>
                  ))}
                </ul>
                {a.steps.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-neutral-500">Setup plan (most unlocked first)</p>
                    <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs">
                      {a.steps.map((s) => (
                        <li key={s.id}>
                          <span className="font-medium">{s.title}</span> <span className="text-neutral-500">({s.who === "you" ? "owner" : "BARRY team"}, {label(s.gate)})</span> → {s.unlocks.join(", ")}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </>
            )}
          </WithSource>
        </Card>

        <Card title="Design-partner readiness">
          <p className="mb-2 text-xs text-neutral-500">
            live proven = a real provider completed it in a persisted, provider-verified transaction · ready = real provider connected, not yet proven · simulated = BARRY&apos;s
            simulator only · needs client&apos;s provider = the retailer must connect their system · not built = no BARRY adapter yet.
          </p>
          <WithSource value={b.designPartner}>
            {(rows) => (
              <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
                {rows.map((r) => (
                  <li key={r.surface} className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:items-center sm:gap-3">
                    <span className="w-48 shrink-0 font-medium">{r.surface}</span>
                    <span className="shrink-0">
                      <Badge tone={statusTone(r.status)}>{label(r.status)}</Badge>
                    </span>
                    <span className="text-xs text-neutral-500">{r.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </WithSource>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Genome — identity, goals, playbook">
            <p className="text-sm">{b.genome.identity.description}</p>
            <Kv k="Goals" v={b.genome.goals.join(", ") || "—"} />
            <Kv k="Checkout" v={b.genome.playbook.commerce.advanceToCheckout.replace(/_/g, " ")} />
            <Kv k="Checkout requires" v={b.genome.playbook.commerce.checkoutRequires.join(", ") || "nothing"} />
            <Kv k="Suggestions" v={b.genome.playbook.suggestions.replace(/_/g, " ")} />
            {b.genome.playbook.salesStyle && <Kv k="Sales style" v={b.genome.playbook.salesStyle} />}
            {b.genome.playbook.handoff && <Kv k="Handoff" v={b.genome.playbook.handoff} />}
            <Kv k="Enabled actions" v={b.genome.enabledActions.join(", ")} />
          </Card>

          <Card title="Genome — policies & authority">
            <ul className="space-y-1 text-sm">
              {b.genome.policies.map((p) => (
                <li key={p.id}>
                  <span className="font-medium">{p.id}</span> <span className="text-neutral-500">{p.description}</span>
                </li>
              ))}
            </ul>
            <div className="mt-2">
              <WithSource value={b.genome.authority}>
                {(a) => (
                  <>
                    <Kv k="Discounts" v={a.discounts} />
                    <Kv k="Refunds" v={a.refunds} />
                    <Kv k="Escalation" v={a.escalation} />
                  </>
                )}
              </WithSource>
            </div>
          </Card>
        </div>

        <Card title="Genome — learned facts">
          <WithSource value={b.genome.facts}>
            {(facts) =>
              facts.length === 0 ? (
                <p className="text-sm text-neutral-500">Nothing learned yet.</p>
              ) : (
                <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
                  {facts.map((f) => (
                    <li key={f.key} className="py-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{f.key}</span>
                        <Badge tone={statusTone(f.status)}>{f.status}</Badge>
                        <Badge>{f.classification}</Badge>
                        <Badge>{f.confidence} confidence</Badge>
                        {f.ownerVerified && <Badge tone="good">owner verified</Badge>}
                      </div>
                      <p className="break-words">{f.value}</p>
                      <p className="break-all text-xs text-neutral-500">
                        from {f.provenance}
                        {f.correctedFrom ? ` · corrected from “${f.correctedFrom}”` : ""}
                        {f.reviewedAt ? ` · reviewed ${when(f.reviewedAt)}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )
            }
          </WithSource>
        </Card>

        <Card title="Capabilities the model may propose · authority">
          <p className="mb-2 text-xs text-neutral-500">
            Beyond the typed flows: what this business&apos;s own systems can execute now, and how the business governs each. The model proposes; these rules decide. A capability no rule allows is refused — reads included.
          </p>
          <WithSource value={b.capabilitySurface}>
            {(caps) =>
              caps.length === 0 ? (
                <p className="text-sm text-neutral-500">None — this business runs only through the typed flows.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {caps.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs">{c.id}</span>
                      <Badge tone={c.effect === "read" ? "neutral" : "warn"}>{c.effect}</Badge>
                      <Badge tone={c.authority === "not_permitted" ? "bad" : c.authority === "owner_approval" ? "warn" : "good"}>{label(c.authority)}</Badge>
                      <span className="text-xs text-neutral-500">inputs: {c.inputs.map((i) => `${i.name}${i.required ? "" : "?"}`).join(", ") || "—"}</span>
                    </li>
                  ))}
                </ul>
              )
            }
          </WithSource>
          <div className="mt-3">
            <p className="text-xs font-medium text-neutral-500">Authority rules</p>
            {b.authorityRules.length === 0 ? (
              <p className="text-sm text-neutral-500">No rules — every capability call is refused.</p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-xs">
                {b.authorityRules.map((r) => (
                  <li key={r.id}>
                    <span className="font-mono">{r.capability}</span> → <Badge tone={r.effect === "allow" ? "good" : r.effect === "deny" ? "bad" : "warn"}>{label(r.effect)}</Badge>
                    {r.when.length > 0 && <span className="text-neutral-500"> when {r.when.map((w) => `${w.field} ${w.op} ${w.value === undefined ? "" : JSON.stringify(w.value)}`).join(" and ")}</span>}
                    <span className="text-neutral-400"> ({r.id})</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card title="Connected systems (capability fabric)">
          <WithSource value={b.connections}>
            {(cs) => (
              <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
                {cs.map((c) => (
                  <li key={c.capability} className="py-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{c.capability}</span>
                      <Badge tone={statusTone(c.status)}>{label(c.status)}</Badge>
                      {c.provider && <span className="text-xs">{c.provider}</span>}
                      {c.simulated && <Badge tone="info">simulated</Badge>}
                      <span className="text-xs text-neutral-500">{c.origin.replace(/_/g, " ")}</span>
                    </div>
                    <p className="text-xs text-neutral-500">
                      last verified {when(c.lastVerifiedAt)}
                      {c.system ? ` · ${c.system.system.kind.replace(/_/g, " ")} via ${c.system.connector} · health ${c.system.health.state} · ${c.system.activation}` : ""}
                    </p>
                    {c.missing.length > 0 && <p className="text-xs text-amber-700 dark:text-amber-400">Blocked: missing {c.missing.join(", ")}</p>}
                    {c.system && c.system.capabilities.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-neutral-500">{c.system.capabilities.length} mapped capabilities</summary>
                        <ul className="mt-1 space-y-0.5 text-xs">
                          {c.system.capabilities.map((m) => (
                            <li key={m.id} className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono">{m.id}</span>
                              <span className="text-neutral-500">v{m.version}</span>
                              <Badge tone={m.status === "active" ? "good" : m.status === "disabled" ? "bad" : "warn"}>{label(m.status)}</Badge>
                              <span className="text-neutral-500">{label(m.provenance)}</span>
                              {m.conformance && <span className="text-neutral-500">conformance {when(m.conformance.passedAt)}</span>}
                              {m.ownerVerificationRequired && m.status !== "active" && <span className="text-amber-700 dark:text-amber-400">needs owner activation</span>}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </WithSource>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Recent conversations">
            <WithSource value={b.recentConversations}>
              {(cs) =>
                cs.length === 0 ? (
                  <p className="text-sm text-neutral-500">No conversations yet.</p>
                ) : (
                  <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
                    {cs.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-2 py-1.5">
                        <Link href={convoHref(c.id)} className="min-w-0 truncate hover:underline">
                          {c.id}
                        </Link>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <Badge>{c.stage}</Badge>
                          <Badge tone={statusTone(c.outcome ?? "pending")}>{c.outcome ?? "pending"}</Badge>
                          <span className="hidden text-xs text-neutral-500 sm:inline">{when(c.updatedAt)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )
              }
            </WithSource>
          </Card>

          <Card title="Recent turns">
            <WithSource value={b.recentTurns}>
              {(ts) =>
                ts.length === 0 ? (
                  <p className="text-sm text-neutral-500">No turns yet.</p>
                ) : (
                  <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
                    {ts.map((t, i) => (
                      <li key={i} className="py-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Link href={convoHref(t.conversationId)} className="text-xs text-neutral-500 hover:underline">
                            {when(t.at)}
                          </Link>
                          <span className="font-medium">{t.intent ?? "—"}</span>
                          {t.failed && <Badge tone="bad">step failed</Badge>}
                          {t.fallback && <Badge tone="warn">reply fallback</Badge>}
                          {t.intent === "understanding_failed" && <Badge tone="bad">not understood</Badge>}
                        </div>
                        <p className="text-xs text-neutral-500">
                          {t.actions.length ? t.actions.join(" → ") : "no action"} · {t.stop ?? "no trace (before 0011)"}
                        </p>
                        {t.capabilities.map((c, j) => (
                          <p key={j} className="text-xs">
                            <span className="font-mono">{c.capability}</span> · authority {c.authority}
                            {c.ruleId ? ` (${c.ruleId})` : ""} · {c.system ?? "no system"} · {c.executed ? (c.verified ? "executed, verified" : "executed") : "not executed"}
                            {c.code ? ` · ${c.code}` : ""}
                          </p>
                        ))}
                      </li>
                    ))}
                  </ul>
                )
              }
            </WithSource>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Approvals">
            <WithSource value={b.approvals}>
              {(xs) =>
                xs.length === 0 ? (
                  <p className="text-sm text-neutral-500">None.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {xs.map((a) => (
                      <li key={a.id}>
                        <Badge tone={statusTone(a.status)}>{a.status}</Badge> <span className="font-medium">{a.requestedAction}</span>{" "}
                        <span className="text-neutral-500">{a.reason}</span>
                      </li>
                    ))}
                  </ul>
                )
              }
            </WithSource>
          </Card>

          <Card title="Payments · orders · bookings">
            <WithSource value={b.payments}>
              {(xs) => (
                <ul className="space-y-1 text-sm">
                  {xs.length === 0 && <li className="text-neutral-500">No payment requests.</li>}
                  {xs.map((p) => (
                    <li key={p.id}>
                      <Badge tone={statusTone(p.status)}>{p.status}</Badge> {p.amount} <span className="text-xs text-neutral-500">{p.provider ?? "—"} · {when(p.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </WithSource>
            <div className="mt-2">
              <WithSource value={b.orders}>
                {(xs) => (
                  <ul className="space-y-1 text-sm">
                    {xs.length === 0 && <li className="text-neutral-500">No orders.</li>}
                    {xs.map((o) => (
                      <li key={o.orderId}>
                        <Badge tone={statusTone(o.status)}>order {o.status}</Badge> {o.total} <span className="text-xs text-neutral-500">{when(o.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </WithSource>
            </div>
            <div className="mt-2">
              <WithSource value={b.bookings}>
                {(xs) => (
                  <ul className="space-y-1 text-sm">
                    {xs.length === 0 && <li className="text-neutral-500">No bookings.</li>}
                    {xs.map((x) => (
                      <li key={x.id}>
                        <Badge tone={statusTone(x.status)}>booking {x.status}</Badge> {when(x.start)} <span className="text-xs text-neutral-500">{x.provider ?? "—"}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </WithSource>
            </div>
          </Card>
        </div>


        <p className="text-xs text-neutral-500">Not tracked yet: {b.notTracked.join(" · ")}.</p>
    </div>
  );
}
