import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — BARRY",
  description: "How BARRY processes personal data.",
};

const LAST_UPDATED = "October 1, 2026";
const CONTACT_EMAIL = "privacy@barry-ai.com";

export default function PrivacyPolicyPage() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "48px 20px", lineHeight: 1.65, fontFamily: "system-ui, sans-serif", color: "#111" }}>
      <h1 style={{ fontSize: 32, marginBottom: 4 }}>BARRY Privacy Policy</h1>
      <p style={{ color: "#555", marginTop: 0 }}>Last updated: {LAST_UPDATED}</p>

      <p>
        This policy explains how BARRY (&ldquo;BARRY&rdquo;, &ldquo;we&rdquo;) processes personal data when businesses use BARRY to run customer
        conversations and operations, including over the WhatsApp Business Platform.
      </p>

      <h2>Data we may process</h2>
      <ul>
        <li>Business account information</li>
        <li>Owner contact details</li>
        <li>WhatsApp messages and related metadata</li>
        <li>Customer conversation data processed on behalf of connected businesses</li>
        <li>Operational and business data needed to provide BARRY features</li>
        <li>Technical logs and security and audit data</li>
      </ul>

      <h2>Why we process data</h2>
      <ul>
        <li>To provide BARRY services</li>
        <li>To operate connected business workflows</li>
        <li>To respond to owner and customer requests</li>
        <li>For security, reliability, debugging and abuse prevention</li>
      </ul>

      <h2>Service providers</h2>
      <p>To deliver the service, data may be processed by:</p>
      <ul>
        <li>Meta / WhatsApp Business Platform</li>
        <li>Hosting and infrastructure providers</li>
        <li>AI and model providers</li>
        <li>Business systems explicitly configured by the customer</li>
      </ul>

      <h2>Sharing and access</h2>
      <p>
        BARRY does not sell personal data to advertisers. Access to data is limited to what is required to provide the service.
      </p>

      <h2>Retention</h2>
      <p>
        Data is retained only as needed for service delivery, security, legal obligations and legitimate business purposes.
      </p>

      <h2>Your choices</h2>
      <p>
        Individuals and businesses can request access to, correction of, or deletion of their data where applicable. Where BARRY processes
        customer conversations on behalf of a business, requests may be directed to that business as well.
      </p>

      <h2>Contact</h2>
      <p>
        Privacy questions or requests: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>
    </main>
  );
}
