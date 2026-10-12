---
name: forms-inbox-triage
description: Work through new Fluent Forms entries like an inbox — review what came in, flag the promising ones, add notes, mark them read, and hand real leads to FluentCRM when that module is on. Use when the user asks what came in on their forms, wants to clear unread entries, or wants leads followed up.
metadata:
  product: fluentforms
  server: fluentsuite
---

# Form inbox triage

Goal: every new entry gets looked at once, the promising ones are flagged and noted, and real leads reach the
CRM. Follow the steps in order. Show previews before every change.

## 1. What came in

1. `forms_list`: which forms have unread entries, and how many.
2. `forms_find_entries` with `status: "unread"` (one form at a time if there are many). Rows show only a name, an
   email and the date. That is enough to sort the pile.

Tell the user how many unread entries there are per form before going further.

## 2. Look closer, one entry at a time

Use `forms_entry_detail` for entries that need a closer look. Reading an entry here does **not** mark it read.

Privacy rules hold everywhere: uploads are file names only, password fields never show, sensitive fields show
`[redacted]`, links and one-time codes are masked. Never try to recover those values, never ask the user to paste
them into the chat, and don't copy personal details into notes or other systems beyond what the task needs.

## 3. Sort each entry

| Looks like | Do |
|---|---|
| A real enquiry, quote request or booking | Flag it: `forms_update_entries` with `action: "favorite"`. Add a short note with `forms_add_entry_note` (what they want, the next step). |
| A question someone should answer | Note what needs answering and who should. |
| Spam or a test | Leave it for the user to decide. If they say so, move it to the trash (`action: "trash"`), which can be undone. |
| Already handled | Mark it read. |

Notes are internal (only admins see them) and plain text. Keep them factual and short.

## 4. Mark read

When an entry has been looked at, mark it read: `forms_update_entries` with `action: "mark_read"`, by ids (one
form per call). More than 10 entries needs the user's confirmation token; show the preview first.

## 5. Hand leads to the CRM (only when the FluentCRM module is on)

If `crm_*` tools are listed and the user wants leads followed up:

1. `crm_contact_profile` with the entry's email: are they already a contact?
2. If not, offer `crm_upsert_contact` (preview first) with the name and email from the entry, a source like
   `source: "Contact form"`, and tags that follow the `crm-tagging-conventions` skill (for example
   `src:contact-form`, `stage:lead`). Never subscribe someone to a marketing list without their consent; a form
   entry is not consent unless the form asked for it.
3. Add a note on the contact with `crm_add_contact_note` if the entry said something worth keeping.

If the CRM tools are not listed, say the FluentCRM module isn't enabled and stop there.

## 6. Report back

Summarise: how many entries were reviewed, flagged, noted, marked read, trashed (if any) and handed to the CRM,
and anything waiting for the user's decision.

## Never

- Submit a form or create an entry (no tool does; this would send notifications and run integrations).
- Delete entries as part of triage. Permanent deletion (`forms_delete_entries`) is for privacy requests and cleanup
  the user asks for explicitly.
