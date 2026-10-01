import { createHash } from "node:crypto";
import type { SystemDescriptor } from "./system";

/**
 * CONNECTION RE-VERIFICATION — when must a system be proven again? From the descriptor alone: the
 * age of the last verification, capability versions vs the contract, manifest (schema) drift against
 * the hash recorded at verification, and credential expiry when the system states one. Feeds
 * readiness, HQ connection health and incidents. Pure.
 */

export type Reverification = { due: boolean; overdue: boolean; reasons: string[]; lastVerifiedAt: string | null; nextDueAt: string | null; schemaDrift: boolean; authExpiry: { expiresAt: string | null; expired: boolean } };

const DUE_AFTER_MS = 30 * 24 * 3600_000;
const OVERDUE_AFTER_MS = 60 * 24 * 3600_000;

export function manifestHash(d: SystemDescriptor): string | null {
  return d.transport.type === "http" ? createHash("sha256").update(JSON.stringify(d.transport.manifest)).digest("hex").slice(0, 16) : null;
}

export function reverificationStatus(d: SystemDescriptor, opts: { now: Date; verifiedManifestHash?: string | null; authExpiresAt?: string | null }): Reverification {
  const reasons: string[] = [];
  const verifiedHash = opts.verifiedManifestHash ?? (typeof d.config.verifiedManifestHash === "string" ? d.config.verifiedManifestHash : null);
  const expiresAt = opts.authExpiresAt ?? (typeof d.config.authExpiresAt === "string" ? d.config.authExpiresAt : null);
  const current = manifestHash(d);
  const schemaDrift = Boolean(verifiedHash && current && verifiedHash !== current);
  if (schemaDrift) reasons.push("the manifest changed since it was verified (schema drift)");
  const expired = Boolean(expiresAt && Date.parse(expiresAt) <= opts.now.getTime());
  if (expired) reasons.push("the credential expired");
  else if (expiresAt && Date.parse(expiresAt) - opts.now.getTime() < 7 * 24 * 3600_000) reasons.push("the credential expires within 7 days");
  const age = d.lastVerifiedAt ? opts.now.getTime() - Date.parse(d.lastVerifiedAt) : null;
  if (!d.simulated && d.activation === "active") {
    if (age === null) reasons.push("never verified");
    else if (age > DUE_AFTER_MS) reasons.push(`last verified ${Math.round(age / 86_400_000)} days ago`);
  }
  if (d.health.state === "down" || d.health.state === "degraded") reasons.push(`health ${d.health.state}${d.health.error ? `: ${d.health.error}` : ""}`);
  const overdue = schemaDrift || expired || (age !== null && age > OVERDUE_AFTER_MS) || (age === null && !d.simulated && d.activation === "active");
  return { due: reasons.length > 0, overdue, reasons, lastVerifiedAt: d.lastVerifiedAt ?? null, nextDueAt: d.lastVerifiedAt ? new Date(Date.parse(d.lastVerifiedAt) + DUE_AFTER_MS).toISOString() : null, schemaDrift, authExpiry: { expiresAt, expired } };
}
