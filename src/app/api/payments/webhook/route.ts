import { NextRequest, NextResponse } from "next/server";
import { handlePaymentWebhook } from "@/lib/runtime";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const headers = Object.fromEntries(req.headers.entries());
  try {
    const result = await handlePaymentWebhook(rawBody, headers);
    return NextResponse.json({ ok: true, duplicate: result.duplicate });
  } catch (err) {
    console.error("[payments:webhook]", err);
    return NextResponse.json({ ok: false, error: "Payment webhook rejected" }, { status: 400 });
  }
}
