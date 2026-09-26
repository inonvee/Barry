import { NextResponse } from "next/server";
import { listBusinessSummaries } from "@/lib/fixtures";

export async function GET() {
  return NextResponse.json({ businesses: listBusinessSummaries() });
}
