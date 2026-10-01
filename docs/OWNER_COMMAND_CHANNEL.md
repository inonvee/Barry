# Owner Command Channel (WhatsApp first)

WhatsApp is the owner's everyday command surface; the web Control Room is the visual one. Both call
the **same owner command service** — there is no WhatsApp-specific automation logic.

```
owner message (WhatsApp / web command bar / voice later)
 → adapter: verify + normalize            src/lib/channels/whatsapp.ts (owner line), src/lib/owner-channel/transport.ts
 → owner identity: exact, active, bound    src/lib/owner-channel/identity.ts
 → business: one link = that business; several = ask (never guess)   src/lib/owner-channel/gateway.ts
 → semantic intent                         src/lib/owner/command.ts
 → command service (idempotent, traced)    src/lib/owner/command-service.ts
     reads ............ the owner read model (getOwnerWorkspace) only
     operations ....... grounded cohort → plan / rules / founder controls → proactive executor (only those keys)
     approvals ........ exact request + revision via a stored single-use prompt → resumeAfterApproval
     rules ............ prepared only → reviewed Train BARRY path
     stop ............. no new work for the cohort (executor honours owner holds); sent stays sent
 → reply delivered (live or dry run) and recorded on the command
 → same records in the Control Room (Today "BARRY is working", Needs you, Money, Inbox)
```

## Identity

- A message is an owner command only if its **provider-verified** sender has an **active link** to a business.
- Linking: a signed-in owner gets a one-time code (Settings → *Run BARRY from your WhatsApp*), valid
  15 minutes, stored as a hash, single use; the owner sends `LINK <code>` **from** the number.
- Each link binds one business and stores a fingerprint of that business's owner access. Revoking, or
  rotating the owner token, stops the link on the next message.
- Owner links never carry founder authority.

## Configuration (names only)

| Variable | Meaning |
|---|---|
| `BARRY_WHATSAPP_OWNER_NUMBERS` | phone_number_id(s) of BARRY's **owner line**. Must differ from customer lines (a number in both is treated as a customer line only). |
| `BARRY_WHATSAPP_OWNER_DISPLAY` | optional E.164 of the owner line, for "Open BARRY in WhatsApp" links |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN` | shared with the customer channel (webhook `/api/channels/whatsapp`) |
| `BARRY_WHATSAPP_SEND=live` | really send; anything else = dry run (recorded, nothing sent) |
| `BARRY_PUBLIC_URL` | base for deep links in WhatsApp replies (falls back to `VERCEL_URL`) |

## Operations

- Startable: abandoned checkout recovery, unpaid payment follow-ups, appointment reminders (the
  workflows that have a real customer message).
- The cohort is grounded from the obligations: every target is eligible or excluded with a reason
  (already paid / bought, contacted recently, attempt limit, a person has the conversation, channel
  off, outside WhatsApp's 24-hour window, waiting on your decision…).
- Plan without proactive follow-ups, an owner rule turned off, or a founder pause → **blocked**, nothing sent.
- More than 10 eligible customers → **proposed**, waiting for the owner's *Start*.
- Lifecycle: `proposed → running → waiting_on_customers → completed | stopped | blocked | failed`.
- Progress is read back from records: contacted (executor attempts), replied (conversation),
  purchased (verified closure), recovered money (provider-verified, never test money).

## Proactive briefs

`POST /api/owner/briefs {businessId, kind}` (owner or founder; schedulable). Decision notices (once per
request revision per owner), "finished the recovery you started", the daily brief (once per local day).
Outside WhatsApp's 24-hour window a template is required — none is configured, so BARRY records the
blocker instead of sending.

## Inspection

`GET /api/hq/owner-commands?businessId=…` (founder): every command with its structured trace
(identity → business → intent → state → grounding → entitlement → authority → plan → approval →
execution → verification → reply → delivery), the operations and the briefs. No chain-of-thought,
no full phone numbers, no tokens.

## Storage

Migration `supabase/migrations/0016_owner_command_channel.sql` (additive; not applied by the build lane)
adds operator-record kinds `owner_identity`, `owner_link_code`, `owner_command`, `owner_operation`,
`owner_prompt`, `owner_brief` on the existing server-only `operator_records` table.
