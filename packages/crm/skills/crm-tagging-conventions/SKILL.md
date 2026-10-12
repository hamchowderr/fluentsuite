---
name: crm-tagging-conventions
description: Conventions for naming and applying FluentCRM tags and lists so segments stay clean. Use before creating tags, tagging contacts in bulk, or building a segment.
metadata:
  product: fluentcrm
  server: fluentsuite
---

# FluentCRM tagging conventions

Tags describe **what we know or what happened** to a contact. Lists describe **what the contact
agreed to receive**. Never use a tag as a substitute for list consent.

## Before you tag

1. Look at the existing tags first (`crm_tags_and_lists`). Reuse an existing tag
   rather than creating a near-duplicate (`VIP` vs `vip-customer` vs `Vip`).
2. Look up the contact (`crm_contact_profile`) or preview the segment before a bulk change.
3. Always run tag changes as a dry run first and show the preview to the user.

## Naming

Use a short prefix that says what kind of fact the tag records, then a kebab-case value:

| Prefix | Meaning | Examples |
| --- | --- | --- |
| `src:` | Where the contact came from | `src:webinar-2026-10`, `src:referral` |
| `int:` | A stated interest | `int:pricing`, `int:wordpress-hosting` |
| `stage:` | Lifecycle stage (only one at a time) | `stage:lead`, `stage:customer`, `stage:churned` |
| `act:` | Something the contact did | `act:downloaded-guide`, `act:attended-demo` |
| `tmp:` | Short-lived campaign targeting; remove when the campaign ends | `tmp:winback-2026-q4` |

Rules:

- Lowercase, kebab-case, no spaces, no emoji, no personal data in tag names.
- Dates as `YYYY-MM` or `YYYY-qN`.
- `stage:` tags are exclusive: when adding a new stage, remove the old one in the same change.
- Remove `tmp:` tags when the campaign they targeted is finished.

## Lists

- Only add contacts to a marketing list when they opted in to it.
- Unsubscribing from a list is not the same as unsubscribing globally. Respect both.
- Never re-subscribe a contact whose status is `unsubscribed`, `bounced` or `complained`.

## Bulk changes

- Changes above the server's bulk threshold need the user's explicit approval: run the dry run,
  show the preview (count and sample), then pass the confirmation token only after the user says yes.
- Prefer one bulk call over many single-contact calls.
