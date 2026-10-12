---
name: crm-win-back-campaign
description: Plan and draft a FluentCRM win-back campaign for lapsed contacts — find who went quiet, size the audience, tag it, and draft (not send) the email for the user to approve. Use when the user wants to re-engage inactive subscribers or past customers.
metadata:
  product: fluentcrm
  server: fluentsuite
---

# Win-back campaign

Goal: re-engage contacts who stopped engaging, without annoying people who opted out.
Follow the steps in order. Never skip a preview, and never send without the user's explicit yes.

## 1. Agree what "lapsed" means

Ask, or propose a default and confirm:

- **Who**: subscribed contacts on a marketing list (e.g. Newsletter). Customers, leads, or both?
- **Quiet for how long**: no activity in 60–90 days is a common default.
- **Who to leave out**: VIPs handled personally, contacts already in another active campaign.

Only `subscribed` contacts can receive a campaign. Never include unsubscribed, bounced or complained
contacts, and never change their status to make them eligible.

## 2. Look before you act

1. `crm_tags_and_lists` — learn the real tag and list names.
2. `crm_find_contacts` with `sort: "recently_active"` — see what activity looks like on this site.
3. `crm_segment_preview` with the agreed lists/tags and exclusions — get the audience size and a
   sample. Show both to the user.

If the segment cannot express "inactive for N days", use `crm_find_contacts` sorted by
`recently_active` and work from the oldest end, or ask the user to pick a list/tag instead.

## 3. Mark the audience

Tag the audience with a temporary campaign tag so it can be targeted and cleaned up later
(see the `crm-tagging-conventions` skill), e.g. `tmp:winback-2026-q4`:

- `crm_tag_contacts` with the segment and `add: ["tmp:winback-…"]`, `create_missing: true`.
- It previews first. Over the bulk threshold it returns a confirmation token: show the preview
  (count and sample) and only pass the token after the user approves.

## 4. Draft the email

Write a short, honest email: what's new, one clear reason to come back, one link, an easy way to
unsubscribe (FluentCRM adds the footer). Keep the subject plain, no fake urgency.

- `crm_draft_campaign` with `audience: { tags_any: ["tmp:winback-…"] }` and any exclusions.
- Show the preview: subject, body summary, estimated recipients. Apply only when the user agrees.
- This creates a **draft**. Nothing is sent. Give the user the review link.

## 5. Sending (only if the user asks and sending is enabled)

`crm_send_campaign` exists only when the server allows sending. If it is available and the user
asks to send or schedule:

1. Run it as a preview. Show subject, recipient count and the sample.
2. Wait for an explicit "yes, send it". Then pass the `confirmation_token` and
   `expected_recipients` from the preview. If the audience changed, preview again.

If sending is not available, tell the user to review and send the draft in FluentCRM.

## 6. Afterwards

- A week later: `crm_campaign_overview` with the campaign id for opens, clicks and unsubscribes.
- Remove the temporary tag when the campaign is done (`crm_tag_contacts` with `remove`).
- Contacts who unsubscribed stay unsubscribed. Do not re-add them anywhere.
