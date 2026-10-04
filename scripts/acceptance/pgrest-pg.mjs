// Run: install `pg` in a scratch directory (not a BARRY dependency), start Postgres with every migration
// applied, then `PGHOST=… PGPORT=… PORT=54400 node pgrest-pg.mjs` and run
// `BARRY_SUPABASE_ACCEPTANCE=1 SUPABASE_URL=http://127.0.0.1:54400 SUPABASE_SERVICE_ROLE_KEY=x npx vitest run __tests__/supabase-path-acceptance.test.ts`.
// LOCAL acceptance shim: the subset of PostgREST's HTTP API that supabase-js uses, executed as REAL SQL on a
// REAL Postgres 16 that has every BARRY migration (0001–0019) applied. The app runs unmodified (real
// supabase-js, real Supabase stores / locks / inbox); only PostgREST itself is replaced. Never points at a
// remote database.
import http from "node:http";
import pg from "pg";

const pool = new pg.Pool({ host: process.env.PGHOST, port: Number(process.env.PGPORT ?? 54398), user: "postgres", database: "postgres", max: 20 });
const PORT = Number(process.env.PORT ?? 54400);
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function colExpr(c) {
  const m = c.match(/^(\w+)(->>?)(\w+)$/);
  return m ? `t.${ident(m[1])}${m[2]}'${m[3].replace(/'/g, "''")}'` : `t.${ident(c)}`;
}
function where(params, args) {
  const parts = [];
  for (const [k, v] of params) {
    if (RESERVED.has(k)) continue;
    const dot = v.indexOf(".");
    let op = v.slice(0, dot), arg = v.slice(dot + 1), neg = false;
    if (op === "not") { neg = true; const d = arg.indexOf("."); op = arg.slice(0, d); arg = arg.slice(d + 1); }
    const c = colExpr(k);
    let sql;
    if (op === "is") sql = arg === "null" ? `${c} is null` : `${c} is ${arg}`;
    else if (op === "in") { args.push(arg.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, ""))); sql = `(${c})::text = any($${args.length}::text[])`; }
    else if (op === "like" || op === "ilike") { args.push(arg.replace(/\*/g, "%")); sql = `(${c})::text ${op} $${args.length}`; }
    else { const OPS = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }; args.push(arg); sql = `${c} ${OPS[op] ?? "="} $${args.length}`; }
    parts.push(neg ? `not (${sql})` : sql);
  }
  return parts.length ? `where ${parts.join(" and ")}` : "";
}
function orderLimit(params) {
  let s = "";
  const order = params.get("order");
  if (order) s += " order by " + order.split(",").map((o) => { const [c, dir, nulls] = o.split("."); return `${colExpr(c)} ${dir === "desc" ? "desc" : "asc"}${nulls ? ` ${nulls.replace("nulls", "nulls ")}` : ""}`; }).join(", ");
  if (params.get("limit")) s += ` limit ${Number(params.get("limit"))}`;
  if (params.get("offset")) s += ` offset ${Number(params.get("offset"))}`;
  return s;
}
function project(rows, select) {
  if (!select || select === "*") return rows;
  const cols = select.split(",").map((s) => s.trim()).filter(Boolean).map((c) => (c.includes(":") ? c.split(":") : [c, c]));
  if (cols.some(([, e]) => e === "*")) return rows;
  return rows.map((r) => Object.fromEntries(cols.map(([a, e]) => { const m = e.match(/^(\w+)->>?(\w+)$/); return [a, m ? (r[m[1]] ?? {})[m[2]] ?? null : r[e]]; })));
}
const pgErr = (e) => ({ code: e.code ?? "PGRST000", message: e.message, details: e.detail ?? null, hint: e.hint ?? null });
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
async function fnSignature(name) {
  const r = await pool.query(`select p.proargnames as names, array(select format_type(t, null) from unnest(p.proargtypes) t) as types from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [name]);
  return r.rows[0];
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const m = url.pathname.match(/^\/rest\/v1\/(.+)$/);
  if (!m) return send(res, 404, { message: "not found" });
  let body = "";
  for await (const c of req) body += c;
  const table = m[1];
  const params = url.searchParams;
  const single = (req.headers["accept"] ?? "").includes("vnd.pgrst.object");
  const prefer = req.headers["prefer"] ?? "";
  const wantRep = prefer.includes("return=representation");
  const count = prefer.includes("count=exact");
  try {
    if (table.startsWith("rpc/")) {
      const name = table.slice(4);
      const sig = await fnSignature(name);
      if (!sig) return send(res, 404, { code: "PGRST202", message: `Could not find the function public.${name} in the schema cache` });
      const input = JSON.parse(body || "{}");
      const args = [], named = [];
      sig.names.forEach((n, i) => { if (n in input) { const v = input[n]; args.push(v !== null && typeof v === "object" ? JSON.stringify(v) : v); named.push(`${ident(n)} := $${args.length}::${sig.types[i]}`); } });
      const r = await pool.query(`select to_jsonb(public.${ident(name)}(${named.join(", ")})) as r`, args);
      return send(res, 200, r.rows[0]?.r ?? null);
    }
    const reply = (rows, status, total) => {
      const out = project(rows, params.get("select"));
      const headers = count ? { "content-range": `0-${Math.max(out.length - 1, 0)}/${total ?? out.length}` } : {};
      if (single) return out.length === 1 ? send(res, status, out[0], headers) : send(res, 406, { code: "PGRST116", message: `JSON object requested, ${out.length} rows returned` });
      return send(res, status, out, headers);
    };
    if (req.method === "GET" || req.method === "HEAD") {
      const args = [];
      const w = where(params, args);
      const rows = (await pool.query(`select to_jsonb(t) as r from public.${ident(table)} t ${w}${orderLimit(params)}`, args)).rows.map((x) => x.r);
      const total = count ? Number((await pool.query(`select count(*) from public.${ident(table)} t ${w}`, args)).rows[0].count) : rows.length;
      if (req.method === "HEAD") return send(res, 200, undefined, { "content-range": `0-${Math.max(total - 1, 0)}/${total}` });
      return reply(rows, 200, total);
    }
    if (req.method === "POST") {
      const items = [].concat(JSON.parse(body || "[]"));
      if (!items.length) return wantRep ? reply([], 201) : send(res, 201, undefined);
      const cols = [...new Set(items.flatMap((i) => Object.keys(i)))];
      const conflict = params.get("on_conflict");
      let tail = "";
      if (conflict) tail = prefer.includes("ignore-duplicates") ? ` on conflict (${conflict.split(",").map(ident).join(",")}) do nothing` : ` on conflict (${conflict.split(",").map(ident).join(",")}) do update set ${cols.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(", ")}`;
      const r = await pool.query(`insert into public.${ident(table)} (${cols.map(ident).join(",")}) select ${cols.map(ident).join(",")} from jsonb_populate_recordset(null::public.${ident(table)}, $1::jsonb)${tail} returning to_jsonb(${ident(table)}) as r`, [JSON.stringify(items)]);
      return wantRep ? reply(r.rows.map((x) => x.r), 201) : send(res, 201, undefined);
    }
    if (req.method === "PATCH") {
      const patch = JSON.parse(body || "{}");
      const cols = Object.keys(patch);
      const args = [JSON.stringify(patch)];
      const w = where(params, args);
      const r = await pool.query(`update public.${ident(table)} t set (${cols.map(ident).join(",")}) = (select ${cols.map(ident).join(",")} from jsonb_populate_record(null::public.${ident(table)}, $1::jsonb)) ${w} returning to_jsonb(t) as r`, args);
      return wantRep ? reply(r.rows.map((x) => x.r), 200) : send(res, 204, undefined, count ? { "content-range": `*/${r.rowCount}` } : {});
    }
    if (req.method === "DELETE") {
      const args = [];
      const r = await pool.query(`delete from public.${ident(table)} t ${where(params, args)} returning to_jsonb(t) as r`, args);
      return wantRep ? reply(r.rows.map((x) => x.r), 200) : send(res, 204, undefined, count ? { "content-range": `*/${r.rowCount}` } : {});
    }
    send(res, 405, { message: "method" });
  } catch (e) {
    send(res, e.code === "23505" ? 409 : e.code === "42P01" ? 404 : 400, pgErr(e));
  }
}).listen(PORT, () => console.log(`pgrest->postgres shim on ${PORT}`));
