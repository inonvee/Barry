import { NextRequest, NextResponse } from "next/server";
import { handlePaymentWebhook } from "@/lib/runtime";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const headers = Object.fromEntries(req.headers.entries());
  try {
    const result = await handlePaymentWebhook(rawBody, headers);
    return NextResponse.json({ ok: true, duplicate: result.duplicate });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Payment webhook failed" },
      { status: 400 }
    );
  }
}
