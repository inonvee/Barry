import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static regression coverage for the database security posture. (The same
 * properties were also checked by applying 0001-0010 to a throwaway local
 * Postgres with Supabase-style roles; these tests keep them from
 * regressing without needing a database.)
 */

const MIGRATIONS_DIR = path.join(__dirname, "..", "supabase", "migrations");
const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
const sql = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8").toLowerCase()]));
const all = files.map((f) => sql[f]).join("\n");

function tablesCreatedIn(text: string): string[] {
  return [...text.matchAll(/create table if not exists (?:public\.)?([a-z_]+)/g)].map((m) => m[1]);
}

describe("migrations", () => {
  it("are contiguously numbered, with 0010 as the additive follow-up", () => {
    expect(files.map((f) => f.slice(0, 4))).toEqual(files.map((_, i) => String(i + 1).padStart(4, "0")));
    expect(files).toContain("0010_payment_binding_and_rich_messages.sql");
  });

  it("enable RLS on every table they create", () => {
    for (const table of tablesCreatedIn(all)) {
      expect(all, table).toMatch(new RegExp(`alter table (?:public\\.)?${table} enable row level security`));
    }
  });

  it("revoke the public API roles from every server-only table", () => {
    const revoked = new Set<string>();
    for (const m of all.matchAll(/revoke all on table([\s\S]*?)from anon, authenticated/g)) {
      for (const name of m[1].split(",")) revoked.add(name.trim().replace(/^public\./, ""));
    }
    for (const table of tablesCreatedIn(all)) expect(revoked.has(table), table).toBe(true);
  });

  it("never add row policies for the public roles", () => {
    expect(all).not.toMatch(/create policy/);
    expect(all).not.toMatch(/grant [a-z, ]+ on (table )?[a-z_.]+ to (anon|authenticated)/);
  });

  it("lock the inventory function to the service role", () => {
    expect(sql["0010_payment_binding_and_rich_messages.sql"]).toMatch(/revoke execute on function reserve_inventory\(text, text, integer, integer\) from public, anon, authenticated/);
  });

  it("pending migrations (0007+) are additive: no drops of tables or data", () => {
    for (const f of files.filter((f) => f >= "0007")) {
      expect(sql[f], f).not.toMatch(/drop table|truncate|delete from|drop column/);
    }
  });

  it("contain no credentials", () => {
    expect(all).not.toMatch(/sk_(live|test)_|whsec_|eyj[a-z0-9_-]{20,}/);
  });

  it("define every column the Supabase store writes for this phase", () => {
    const m0009 = sql["0009_learn_business.sql"];
    for (const col of ["run_id", "status", "owner_verified", "corrected_from", "reviewed_by", "reviewed_at", "fact_key", "fact_value", "source"]) {
      expect(m0009, col).toMatch(new RegExp(`\\b${col}\\b`));
    }
    expect(m0009).toMatch(/'fetching', 'extracting', 'needs_owner', 'ready', 'failed'/);
    expect(m0009).toMatch(/owner_verified = \(status in \('verified', 'corrected'\)\)/);
    const m0010 = sql["0010_payment_binding_and_rich_messages.sql"];
    expect(m0010).toMatch(/add column if not exists binding jsonb/);
    expect(m0010).toMatch(/add column if not exists provider_transaction_id text/);
    expect(m0010).toMatch(/alter table messages\s+add column if not exists rich jsonb/);
    expect(m0010).toMatch(/snapshothash.*\^\[0-9a-f\]\{64\}\$/);
  });
});

const SRC = path.join(__dirname, "..", "src");
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(tsx?|jsx?)$/.test(e.name) ? [path.join(dir, e.name)] : []));
}

const SERVER_ONLY = [
  /^@\/lib\/store(\/|$)/,
  /^@\/lib\/state\/supabase/,
  /^@\/lib\/payments/,
  /^@\/lib\/connections/,
  /^@\/lib\/learn-business/,
  /^@\/lib\/commerce/,
  /^@\/lib\/owner-auth/,
  /^@\/lib\/runtime/,
  /^@\/lib\/reasoner\/openai/,
  /^node:/,
  /^@supabase\//,
  /^openai$/,
];

describe("client bundles never import server-only code", () => {
  const clientFiles = walk(SRC).filter((f) => /^\s*["']use client["']/.test(fs.readFileSync(f, "utf8")));

  it("finds the client components", () => {
    expect(clientFiles.length).toBeGreaterThan(3);
  });

  it.each(clientFiles.map((f) => [path.relative(SRC, f), f]))("%s imports only client-safe modules (types excepted)", (_rel, file) => {
    const text = fs.readFileSync(file, "utf8");
    const valueImports = [...text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    const offending = valueImports.filter((spec) => SERVER_ONLY.some((re) => re.test(spec)));
    expect(offending).toEqual([]);
  });

  it("no source file ships a service-role key to the browser", () => {
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(SERVICE_ROLE|SECRET|API_KEY|OWNER_TOKEN)/);
    }
  });
});
