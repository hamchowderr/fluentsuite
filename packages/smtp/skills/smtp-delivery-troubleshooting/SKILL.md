---
name: smtp-delivery-troubleshooting
description: Find out why a WordPress site's emails are failing (FluentSMTP) and fix it safely — check status, read the delivery report, inspect a failed email, name the likely cause, and resend only with the user's yes. Use when the user says emails are not arriving, a form or order email went missing, or FluentSMTP shows failures.
metadata:
  product: fluentsmtp
  server: fluentsuite
---

# Email delivery troubleshooting

Goal: explain why emails fail, point to the fix, and only then, with the user's explicit yes, resend what
failed. Follow the steps in order.

## 1. Status first

Call `smtp_status`.

- **Simulate mode on**: FluentSMTP logs emails but sends none. That alone explains "nothing arrives".
  Tell the user; turning it off is their call in FluentSMTP's settings (no tool changes it).
- **No connection**: the site cannot send at all. They need to set one up in FluentSMTP.
- **Logging off**: failures leave no trace. Suggest turning logging on before going further.
- Note the failure rate for the last 7 days and the most recent failure.

## 2. The pattern

Call `smtp_delivery_report` (default: the last 30 days; narrow it if the user names a date).

- Group by **failure reason**. One reason covering most failures usually means one root cause.
- Look at **sources**: is it one plugin (for example FluentCRM or a form plugin) or everything?
- Check **when** it started: the day with the most failures, or the first day with any.

## 3. One example

Pick the newest failure for the main reason and call `smtp_email_detail` with its id. Add
`include_body: true` only if the content matters (for example to confirm which form sent it).
Links and one-time codes in logged emails are masked. That is deliberate: never try to recover them, and
never ask the user to paste a password-reset link or code into the chat.

## 4. Name the likely cause

Common errors and what they usually mean:

| Error contains | Likely cause | Fix (by the site owner) |
|---|---|---|
| `Could not connect to SMTP host`, `Connection refused`, `timed out` | Wrong host or port, or the server blocks outgoing SMTP | Check host/port/encryption; ask the host whether port 587/465 is open, or use an API-based provider |
| `Could not authenticate`, `535`, `Username and Password not accepted` | Wrong or expired credentials, or an app password is required | Re-enter the credentials in FluentSMTP |
| `550`, `mailbox unavailable`, `recipient rejected` | The recipient address does not exist or refuses mail | Fix the address; do not resend to it |
| `sender address rejected`, `not verified`, `domain not verified` | The From address or domain is not verified with the provider | Verify the domain/sender with the provider (SPF, DKIM) |
| `quota`, `rate limit`, `429` | The provider's sending limit was hit | Wait, or raise the plan's limit |

Say how sure you are. If the errors don't fit, show the raw (masked) error and suggest the user's host or
provider support.

## 5. After the fix: test, then resend

Only after the user says the cause is fixed:

1. `smtp_send_test_email` to an address the user chooses. Show the preview; send only on their yes.
2. If the test works, offer to resend what failed with `smtp_resend_failed_emails` (by ids, or failed in a
   date range, up to 50 at once). Show the preview — the count, sample recipients and subjects, the
   original errors — and resend only on their explicit yes.

Rules for resending:

- Never resend emails that failed because the **recipient** was rejected (550 / mailbox unavailable).
  Leave those out by passing ids.
- Think about timing: a two-week-old order confirmation or password reset may confuse more than help.
  Password-reset and login emails usually should **not** be resent; the person can ask again.
- A resend goes only to the original recipients. There is no way to send a logged email to someone else.
- Sending tools exist only when the server allows sending and the site's FluentSuite Bridge allows it.
  If a sending tool is missing or refuses, say so; do not look for a workaround.

## 6. Tidy up (optional)

If the user wants old logs gone, or a person asked for their data to be removed, use
`smtp_delete_email_logs` (by ids, by exact recipient, or older than N days). It always previews and needs
their confirmation. There is no "delete all".
