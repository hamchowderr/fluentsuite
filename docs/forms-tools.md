# Fluent Forms tools

Status: **approved by the owner**: all 8 tools, the PII rules, read-only payments, and one extra, the
`forms-inbox-triage` skill. No MCP Apps view for Forms: previews and tokens stay text-only. ✅ marks what has
shipped: all 8 tools, the PII rules and the `forms-inbox-triage` skill.

FluentSuite is an independent project and is not affiliated with WPManageNinja. These tools are for
Fluent Forms 6.2.x (free), through its REST API (`fluentform/v1`). No bridge plugin is needed.

Fluent Forms 6.2 also ships its own MCP tools (WordPress Abilities API / MCP Adapter). FluentSuite is separate:
it uses the REST API only and neither uses nor copies that code. What it adds is the safety layer: previews,
tokens, PII rules and masking.

## Permissions

Every route is gated by Fluent Forms' own permissions, per form: `fluentform_entries_viewer` to read entries,
`fluentform_manage_entries` to change them.

## Tools

| # | Tool | Kind | Purpose | Safety |
|---|---|---|---|---|
| 1 | ✅ `forms_list` | read | Forms with status, entry counts (total, unread) and last entry date; searchable. | Read only. |
| 2 | ✅ `forms_form_summary` | read | One form's fields (label, type, required), notifications (name, on/off, recipient type, addresses masked), attached integration feeds (name, on/off), payments yes/no, confirmation type. | Never reads integration API keys (they live in global settings). |
| 3 | ✅ `forms_find_entries` | read | Entries of one form or all, by status (unread, read, favorite, trashed), date range or search. Short rows: id, date, status, a name and email picked by field type, payment status. Cursor paging. | No full field values, no files, no IP addresses. |
| 4 | ✅ `forms_entry_detail` | read | One entry, every field by label, under the [PII rules](#pii-rules); optionally its notes and activity log. | See PII rules. |
| 5 | ✅ `forms_report` | read | Entries over time per form, completion rate, top forms, revenue if payments are used. | Read only. |
| 6 | ✅ `forms_update_entries` | write | Mark read/unread, favorite/unfavorite, trash/restore, by ids or a filter (form + status + date). | Always previews; more than 10 needs the token; trash is reversible. |
| 7 | ✅ `forms_add_entry_note` | write | Add an internal note to an entry. | Previews; HTML escaped. |
| 8 | ✅ `forms_delete_entries` | write, destructive | Permanently delete entries by ids, "trashed and older than N days", or an exact email (privacy). | Always needs the token, bound to the previewed count; capped; no delete-all. The preview says Fluent Forms also deletes the entries' uploaded files. |

None of these tools sends email, so none needs `allowSending`.

### Not included, on purpose

- Submitting forms or creating entries: that is what fires notifications, feeds, webhooks and payments.
- Resending notifications, editing entry values (Pro), changing form settings, notifications or integrations.
- Creating, duplicating or deleting forms; bulk export of all entries; Fluent Forms' AI and MCP settings.

## PII rules ✅

- **Lists** (tool 3) show only a name, an email and the date.
- **Search** (tool 3's `search`) is done by Fluent Forms on the server over every stored value of an entry,
  including fields FluentSuite shows as `[redacted]`. So a search for a known value (for example a tax id) reveals
  which entry holds it, even though the value itself is never shown. The tool's description says so.
- **Detail** (tool 4):
  - upload fields (`input_file`, `input_image`) show **file names only**, never the (publicly fetchable) URLs;
  - password fields are never shown; signatures (Pro) show as "signed";
  - IP and user agent are left out; city and country are shown;
  - long text is capped;
  - secret masking (reset, login, magic and verification links; one-time codes) applies to every value;
  - fields whose name or label looks sensitive show `[redacted]`. Default list: password, ssn/social, card,
    cvv/cvc, iban, routing/account number, tax id, passport, licence number, secret, token. The owner can extend
    it with `forms.redactFields` / `FLUENTSUITE_FORMS_REDACT_FIELDS`;
  - `fields: [...]` narrows the output to named fields.
- Nothing from entries is written to FluentSuite's logs.

## Reading an entry never marks it read

Fluent Forms' `GET submissions/{id}` marks an unread entry as read when it is opened (`SubmissionService::find`,
filter `fluentform/auto_read_submission`, which can't be set over REST). FluentSuite never calls it:
`forms_entry_detail` finds the entry through the list route (search by id, exact match, the trash too), which has
no side effects. Tests and the live contract test check the entry stays unread.

## Payments (free vs Pro)

- **Free 6.2** includes the payment module: payment fields, item quantity, payment summary, subscriptions, and
  **Stripe** as the only gateway. Entries carry payment status, method, type, currency, total and paid.
- **Pro** adds the other gateways (PayPal, Mollie, Razorpay, …) and coupons.
- Card data is never stored (Stripe handles it). The tools show amount, currency, status and method only, and
  take no payment actions (no refunds, no status changes).

## What triggers emails and integrations

- In free Fluent Forms, notifications, integration feeds (FluentCRM included) and webhooks run when an entry is
  **created** (`fluentform/submission_inserted`, `fluentform/notify_on_form_submit`) and on a successful payment.
  No FluentSuite tool creates entries or calls the `form-submit` route.
- Status changes, notes and deletes fire `fluentform/after_submission_status_update`,
  `fluentform/submission_note_stored` and `fluentform/after_deleting_submissions`. Nothing in free listens to
  them; Pro or another plugin could, so each write preview names the hook it fires.

## Extra: the `forms-inbox-triage` skill ✅

Review new entries, flag the promising ones, add notes and mark them read, and hand leads to the `crm_*` tools
when the FluentCRM module is on. No MCP Apps view for Forms tools.

## How the writes work

- All three use only `POST submissions/bulk-actions` (one form per call) and `POST submissions/{id}/notes`. Never
  `form-submit`, never `GET submissions/{id}`.
- `forms_update_entries`: read/unread → status; favorites → `other.make_favorite` / `other.unmark_favorite`;
  trash → status `trashed`; restore → status `read` (Fluent Forms has no separate restore). Entries already in
  that state are skipped. The token covers the exact entries previewed.
- `forms_delete_entries`: exactly one of ids (with `form_id`), `trashed_older_than_days` (entries in the trash
  created more than N days ago) or an exact `email` (matched exactly on the form's email fields, not by substring);
  at most 200 per call; refused if more match. The token covers the previewed count and the exact entries.
  `other.delete_permanently` also deletes the entries' uploaded files, which the preview says.

## Test site

Fluent Forms 6.2.15 with four test forms and 62 fictional entries. See [test-site.md](test-site.md).
