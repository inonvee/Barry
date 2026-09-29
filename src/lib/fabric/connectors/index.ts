/**
 * Loads every connector registration. Vendor-specific code lives in these
 * modules (and the adapters they wrap) — never in the planner or runtime.
 */
import "@/lib/fabric/builtin";
import "@/lib/commerce/registry";
import "@/lib/payments/registry";
import "@/lib/scheduling/registry";
import "./http";
