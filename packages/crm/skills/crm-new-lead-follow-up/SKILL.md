---
name: crm-new-lead-follow-up
description: Triage recent FluentCRM signups — review who joined, tag them by interest and lifecycle stage, flag the hot ones, and log follow-up notes. Use for a daily or weekly new-lead review, or when the user asks "who signed up and what should we do about them?".
metadata:
  product: fluentcrm
  server: fluentsuite
---

# New-lead follow-up

Goal: every new contact gets looked at, tagged consistently, and the promising ones get a human
follow-up. Read-only steps first; every change previews first.

## 1. Who joined

- `crm_recent_signups` with `days` set to the review window (1 for daily, 7 for weekly).
  It returns the total, per-day counts, sources and the newest contacts with tags and lists.
- Summarise for the user: how many, from which sources, anything unusual (a spike from one source,
  many pending double opt-ins).

## 2. Look closer at the promising ones

For contacts that look promising (from a high-intent source, with an `int:*` tag, or a business
email domain), call `crm_contact_profile` by email to see custom fields, notes and engagement.
Do not invent facts about a contact; say what the CRM shows.

## 3. Tag consistently

Use the `crm-tagging-conventions` skill:

- `stage:lead` for new leads (only one `stage:*` tag at a time).
- `src:*` for where they came from, `int:*` for stated interests.

Group contacts that need the same tags and use one `crm_tag_contacts` call per group, by `emails`.
It previews first; bulk changes return a token to pass only after the user approves.

## 4. Lists only with consent

Add contacts to a marketing list with `crm_update_list_membership` only if they opted in to it
(the signup form or the user says so). The tool never adds unsubscribed, bounced or complained
contacts. Pending contacts have not confirmed yet; leave their status alone.

## 5. Hand off the hot leads

For each contact the user wants to follow up personally:

- `crm_add_contact_note` with `type: "activity"` and a short title, e.g.
  "Follow up: asked about annual pricing (signup form)". Previews first.
- Optionally tag them (e.g. `int:pricing`) so they can be found later with `crm_find_contacts`.

## 6. Report back

End with a short summary: how many new contacts, how many tagged, who needs a human follow-up and
why. If the user wants a nurture email, suggest drafting one with `crm_draft_campaign`, which never
sends on its own.
