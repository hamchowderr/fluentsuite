# FluentCRM tools: proposed list

**Status: approved by the owner** (all 14 tools, plus `crm_send_campaign` behind its own switch).
✅ marks tools that are implemented.

Design rules (see [architecture.md](architecture.md), ADR-004 and ADR-005):

- Each tool does one whole job. No tool mirrors a single REST endpoint.
- Read tools are always available. Write tools exist only when `writes.enabled` is true.
- Every write previews first (`dry_run` defaults to `true`).
- Bulk changes (more than `writes.bulkThreshold` contacts, default 10), destructive changes, and
  anything that sends email need a `confirmation_token` from the preview.
- List-style output is paginated with opaque cursors.

## Read tools (8)

| # | Tool | Purpose | View |
|---|---|---|---|
| 1 | `crm_contact_profile` ✅ | One contact by email or id: status, tags, lists, custom fields, engagement stats, recent emails, notes, and purchase stats when an e-commerce integration provides them. | Contact card |
| 2 | `crm_find_contacts` ✅ | Find or segment contacts by text, tags, lists, status, contact type and created/active date ranges. Returns a total count plus a page of short rows. Use it for "how many…" questions too. | |
| 3 | `crm_tags_and_lists` ✅ | All tags and lists with contact counts, so the model picks real names instead of guessing. | |
| 4 | `crm_segment_preview` ✅ | Size and sample of an audience defined by tags/lists/status, with exclusions. The step before a bulk change or a campaign. | Segment preview |
| 5 | `crm_campaign_overview` ✅ | Recent campaigns with status and key stats, or one campaign in detail: sent, opens, clicks, unsubscribes, top links. | |
| 6 | `crm_sequence_overview` ✅ | Email sequences with subscriber counts and per-step performance. FluentCRM Pro only; answers clearly when Pro is missing. | |
| 7 | `crm_recent_signups` ✅ | New contacts in a time window, with source, tags and lists, grouped by day. | |
| 8 | `crm_audience_summary` ✅ | The "pipeline" view: totals by status and contact type, growth over a period, top tags and lists, email activity trend. | |

## Write tools (6)

| # | Tool | Purpose | Safety |
|---|---|---|---|
| 9 | `crm_tag_contacts` ✅ | Add and/or remove tags for contacts given by emails or by a segment. Optionally create missing tags. | Dry run; confirmation above the bulk threshold |
| 10 | `crm_update_list_membership` ✅ | Subscribe or unsubscribe contacts to or from lists, by emails or segment. Never re-subscribes contacts who unsubscribed, bounced or complained. | Dry run; confirmation above the bulk threshold |
| 11 | `crm_upsert_contact` ✅ | Create a contact or update one found by email: name, fields, custom fields, tags, lists. Never sends a double opt-in email unless asked, and then needs confirmation. | Dry run; shows a field-by-field diff |
| 12 | `crm_set_contact_status` ✅ | Change global status (subscribed, unsubscribed, pending) for one or more contacts. | Dry run; confirmation for unsubscribes and bulk |
| 13 | `crm_add_contact_note` ✅ | Log a note, call or meeting on a contact's timeline. | Dry run |
| 14 | `crm_draft_campaign` ✅ | Create a draft campaign (title, subject, body, audience) and show the audience size. Never sends or schedules. | Dry run; draft only |

## Sending (owner decision: included, off by default)

| Tool | Purpose | Safety |
|---|---|---|
| `crm_send_campaign` ✅ | Send now, or schedule, an existing **draft** campaign. | Listed only when `writes.enabled` **and** `writes.allowSending` (`FLUENTSUITE_ALLOW_SENDING`) are on. Always previews subject, recipient count and a sample. Needs the confirmation token for send-now and schedule alike, plus `expected_recipients` = the previewed count; the token is bound to that count. Refuses if the audience grew since the preview, and checks again after FluentCRM queues the recipients, before anything is sent. Only list/tag audiences (dynamic segments are sent from wp-admin). |

## Not planned

- Deleting contacts, tags, lists or campaigns. Do this in wp-admin.
- Automations (funnels) editing. A read-only overview can come later.
- Raw "call any endpoint" tools.

## MCP Apps views

- **Contact card** (`ui://crm/contact-card.html`) ✅: for `crm_contact_profile`.
- **Action preview** (`ui://crm/action-preview.html`) ✅: for `crm_segment_preview` (count, breakdown
  and sample) and for the dry runs of `crm_tag_contacts`, `crm_update_list_membership`,
  `crm_set_contact_status`, `crm_draft_campaign` and `crm_send_campaign`. It shows exactly what would
  change, with **Approve** and **Cancel**. Approve re-calls the same tool through the host with
  `dry_run=false` and the confirmation token (and `expected_recipients` for sends); the server checks
  the token as usual. The text output carries the same token, so hosts without MCP Apps work the same.

## Skills (SKILL.md playbooks)

- `crm-tagging-conventions` ✅: tag naming, list consent, bulk-change etiquette.
- `crm-win-back-campaign` ✅: define "lapsed", preview and tag the audience, draft (not send) the
  win-back email, send only with explicit approval, then measure and clean up.
- `crm-new-lead-follow-up` ✅: review recent signups, tag by source/interest/stage, keep list consent,
  log follow-up notes for hot leads, report back.
