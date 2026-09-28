const CONNECTIONS = [
  { capability: "payments", provider: "PayPlus / Stripe", status: "setup needed", lastVerified: "Not verified", action: "Connect provider" },
  { capability: "scheduling", provider: "Google Calendar", status: "connected", lastVerified: "Recent test", action: "Test connection" },
  { capability: "commerce", provider: "Custom Commerce", status: "development", lastVerified: "Mock contract", action: "View contract" },
  { capability: "messaging", provider: "WhatsApp / Instagram", status: "later", lastVerified: "Not connected", action: "Prepare channel" },
];

export default function ConnectionsPage() {
  return (
    <main className="min-h-screen bg-[#f7f7f4] px-5 py-8 text-[#171717]">
      <section className="mx-auto max-w-5xl">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-[#667085]">Business connections</p>
        <h1 className="mt-3 text-3xl font-semibold">Capability registry</h1>
        <p className="mt-3 max-w-2xl text-base text-[#475467]">
          Barry resolves capabilities per business, then uses the matching provider adapter on the server. Secrets stay behind credential references.
        </p>

        <div className="mt-8 overflow-hidden rounded-lg border border-[#d0d5dd] bg-white">
          <div className="grid grid-cols-[1fr_1fr_1fr_1fr] border-b border-[#eaecf0] bg-[#f9fafb] px-4 py-3 text-sm font-medium text-[#475467]">
            <div>Capability</div>
            <div>Provider</div>
            <div>Status</div>
            <div>Next action</div>
          </div>
          {CONNECTIONS.map((connection) => (
            <div key={connection.capability} className="grid grid-cols-[1fr_1fr_1fr_1fr] items-center border-b border-[#eaecf0] px-4 py-4 last:border-b-0">
              <div className="font-medium capitalize">{connection.capability}</div>
              <div className="text-[#475467]">{connection.provider}</div>
              <div>
                <span className="rounded-full border border-[#d0d5dd] px-2 py-1 text-sm text-[#475467]">{connection.status}</span>
                <div className="mt-2 text-xs text-[#667085]">{connection.lastVerified}</div>
              </div>
              <div>
                <button className="rounded-md border border-[#98a2b3] px-3 py-2 text-sm font-medium text-[#344054]">{connection.action}</button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
