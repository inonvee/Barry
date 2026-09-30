import { hqAuthError } from "@/lib/hq/auth";
import { getFleet } from "@/lib/hq/fleet";
import { currentRelease } from "@/lib/release/manifest";

/** The fleet read model as JSON (founder only). */
export async function GET(req: Request) {
  const denied = hqAuthError(req);
  if (denied) return denied;
  const [fleet, release] = await Promise.all([getFleet(), currentRelease()]);
  return Response.json({ fleet, release });
}
