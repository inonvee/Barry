import { connection } from "next/server";
import { requireFounder } from "@/lib/hq/guard";
import { FounderWhatsappAccess } from "./FounderWhatsappAccess";

/** Founder WhatsApp access: link a phone to Founder BARRY (one-time code), see linked numbers (masked), revoke. HQ founder only. */
export default async function FounderWhatsappPage() {
  await connection();
  await requireFounder();
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 16, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600 }}>Founder WhatsApp</h1>
      <p style={{ fontSize: 13, opacity: 0.75 }}>Talk to Founder BARRY from WhatsApp. Get a one-time code here and send “LINK &lt;code&gt;” from your phone to BARRY&apos;s founder line within 15 minutes. Only the hash of the code is stored; rotating the founder token ends every link.</p>
      <FounderWhatsappAccess />
    </main>
  );
}
