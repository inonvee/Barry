-- MEGA RELIABILITY MISSION Part 15 finding: increment_inventory_consumed
-- (0002) was atomic against LOST updates (two concurrent fulfillOrder
-- calls never clobber each other's write) but NOT against OVERSELLING —
-- it incremented consumed_quantity unconditionally, with no awareness of
-- the offer's actual stock level. Two customers who both passed
-- checkInventory while exactly one unit remained (a real, ordinary race —
-- checkInventory and fulfillOrder happen turns apart, with a full payment
-- flow in between) could BOTH successfully fulfillOrder for the same last
-- unit; the base quantity check only ever ran once, long before either
-- payment completed, and the read-side clamp in getInventory
-- (`Math.max(0, baseQuantity - consumed)`) hid the overselling from
-- display without preventing it.
--
-- Replaces it with a single atomic UPDATE guarded by the caller-supplied
-- base quantity: the row only advances when doing so would NOT exceed
-- stock, and the function reports back whether it actually reserved the
-- unit. The application (fulfillOrder in tools/definitions.ts) must
-- treat a `false` return as "sold out" and refuse to fulfill — never
-- silently decrement past the cap.
drop function if exists increment_inventory_consumed(text, text, integer);

create function reserve_inventory(
  p_business_id text,
  p_sku text,
  p_quantity integer,
  p_base_quantity integer
) returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_reserved boolean;
begin
  insert into inventory_adjustments (business_id, sku, consumed_quantity)
  values (p_business_id, p_sku, 0)
  on conflict (business_id, sku) do nothing;

  update inventory_adjustments
  set consumed_quantity = consumed_quantity + p_quantity
  where business_id = p_business_id
    and sku = p_sku
    and consumed_quantity + p_quantity <= p_base_quantity
  returning true into v_reserved;

  return coalesce(v_reserved, false);
end;
$$;
