import { NextRequest, NextResponse } from "next/server";
import { getBusinessGraph } from "@/lib/fixtures";

export async function GET(req: NextRequest) {
  const businessId = req.nextUrl.searchParams.get("businessId");
  if (!businessId) return NextResponse.json({ error: "businessId is required" }, { status: 400 });
  try {
    const graph = getBusinessGraph(businessId);
    return NextResponse.json({ graph });
  } catch {
    return NextResponse.json({ error: `Unknown business: ${businessId}` }, { status: 404 });
  }
}
