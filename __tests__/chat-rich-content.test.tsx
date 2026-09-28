import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatPanel, RichContent } from "@/components/ChatPanel";

describe("simulator channel renders the rich payload, not markdown", () => {
  it("renders product cards and a payment link from structured data", () => {
    const html = renderToStaticMarkup(
      <RichContent
        rich={{
          products: [{ title: "Midnight Wrap Dress", price: "420 ILS", url: "https://shop.test/p/1", imageUrl: "https://shop.test/i/1.jpg", availability: "M: in stock" }],
          paymentUrl: "https://pay.test/checkout/1",
        }}
      />
    );
    expect(html).toContain("Midnight Wrap Dress");
    expect(html).toContain("420 ILS");
    expect(html).toContain('href="https://shop.test/p/1"');
    expect(html).toContain('href="https://pay.test/checkout/1"');
    expect(html).not.toContain("**");
    expect(html).not.toContain("![");
  });

  it("never renders non-http(s) links from a payload", () => {
    const html = renderToStaticMarkup(
      <RichContent rich={{ products: [{ title: "X", url: "javascript:alert(1)", imageUrl: "data:text/html,hi" }], paymentUrl: "javascript:alert(2)" }} />
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
  });

  it("chat bubbles show the plain reply text with its rich content", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        messages={[
          { role: "barry", content: "Here's what I found:\n1. Midnight Wrap Dress - 420 ILS", at: "2026-01-01T00:00:00Z", rich: { products: [{ title: "Midnight Wrap Dress" }] } },
        ]}
        onSend={() => undefined}
        sending={false}
        paymentPrompt={null}
        onSimulatePayment={() => undefined}
      />
    );
    expect(html).toContain("data-testid=\"rich-content\"");
    expect(html).toContain("Here&#x27;s what I found:");
  });
});
