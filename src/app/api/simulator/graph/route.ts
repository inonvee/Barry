import { NextRequest, NextResponse } from "next/server";
import { getBusinessGraph } from "@/lib/fixtures";
import { simulatorAccessError } from "@/lib/simulator-access";

export async function GET(req: NextRequest) {
  const businessId = req.nextUrl.searchParams.get("businessId");
  const denied = simulatorAccessError(req, businessId);
  if (denied) return denied;
  try {
    const graph = getBusinessGraph(businessId!);
    return NextResponse.json({ graph });
  } catch {
    return NextResponse.json({ error: `Unknown business: ${businessId}` }, { status: 404 });
  }
}
