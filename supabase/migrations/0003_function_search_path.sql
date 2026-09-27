-- Security advisory fix: pin increment_inventory_consumed's search_path.
-- Without an explicit search_path, a plpgsql function resolves unqualified
-- identifiers using the caller's search_path at call time, which a
-- privileged caller (this project's service-role-only access model) could
-- have manipulated to point `inventory_adjustments` at an attacker-created
-- table/view in another schema. Pinning it removes that entire class of
-- search_path-hijacking attack.
alter function increment_inventory_consumed(text, text, integer)
  set search_path = public, pg_temp;
