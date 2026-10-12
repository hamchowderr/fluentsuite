# FluentSMTP tools

Status: **approved by the owner** and **built** ✅: the bridge, all 7 tools, secret masking, the action-preview
view and the troubleshooting skill.

FluentSuite is an independent project and is not affiliated with WPManageNinja. These tools are for
FluentSMTP 2.4.x.

## FluentSMTP has no REST API

FluentSMTP's admin screens talk to WordPress through `admin-ajax.php`. That needs a logged-in browser cookie
and a nonce, and WordPress Application Passwords (how FluentSuite signs in) do not work there. The only REST
route FluentSMTP registers is its Outlook OAuth callback. Checked in the 2.4.1 source: `app/Http/routes.php`
and `includes/Core/CoreTrait.php`.

**Approved: a small companion plugin, FluentSuite Bridge** (PHP, in this repo, MIT).

- It adds REST routes under `fluentsuite/v1/smtp/*` that call FluentSMTP's own PHP code, so they work with
  Application Passwords like every other module.
- Access uses FluentSMTP's own permission check, `fluentMailCurrentUserCanManage()` (administrators by
  default).
- It **never returns secrets**. Connection settings pass through an allowlist (provider, sender emails,
  default and fallback), so API keys, passwords and OAuth tokens stay on the site.
- Sending routes stay off until the site owner adds `define('FLUENTSUITE_BRIDGE_ALLOW_SENDING', true);`
  to `wp-config.php`. That is a second lock, on the site, separate from FluentSuite's `allowSending`.

The other plugins on the build list (Fluent Forms, FluentBooking, FluentCart, Fluent Support,
FluentAffiliate) have real REST APIs. Only SMTP needs the bridge.

Rejected alternatives:

- Signing in with the real WordPress password to collect nonces: this needs the real password, it's
  fragile, and it breaks the auth model.
- Skipping FluentSMTP: it's next in the build order.

## Tools

| # | Tool | Kind | Purpose | Safety |
|---|---|---|---|---|
| 1 | ✅ `smtp_status` | read | Connections (provider, sender emails, default and fallback), simulate mode, logging and retention, sent and failed totals, the last 7 days, the most recent failure. | Never returns credentials (the bridge allowlists fields). |
| 2 | ✅ `smtp_find_email_logs` | read | Search the email log by status, date range, recipient, subject or source. Short rows, cursor paging. | No message bodies in lists. |
| 3 | ✅ `smtp_email_detail` | read | One logged email: recipients, sender, subject, status, provider response or error, retries, source, attachment names. | The body only with `include_body`, as plain text up to 2,000 characters, with [secrets masked](#secret-masking). No attachment contents. Auth-looking headers are masked. |
| 4 | ✅ `smtp_delivery_report` | read | Sent and failed per day for a date range, failure reasons grouped by error, top sending sources. | Read only. |
| 5 | ✅ `smtp_send_test_email` | **sending** | Send FluentSMTP's test email to one address through a chosen sender or connection. | Needs `allowSending` and the bridge lock. Always previews first: from, connection, to, and whether simulate mode is on. Always needs the token. |
| 6 | ✅ `smtp_resend_failed_emails` | **sending** | Resend failed emails, chosen by log ids or as "failed in this date range", up to 50 per call. | Needs `allowSending` and the bridge lock. Previews the count, a sample of recipients and subjects ([secrets masked](#secret-masking)), and the original errors. The token is bound to exactly the previewed emails (so to their count). Only `failed` emails, each only to its original recipients. **No** "send to someone else" option, because forwarding a logged password-reset email would be a way to take over an account. |
| 7 | ✅ `smtp_delete_email_logs` | write, destructive | Delete logs by ids, by recipient (privacy or GDPR requests), or older than N days. | Always needs the token. The preview shows how many would be deleted. Never offers "delete all". |

**Sending tools** are listed only when writes, sending (`writes.allowSending` /
`FLUENTSUITE_ALLOW_SENDING`) and the bridge's wp-config lock all allow it.

### Secret masking ✅

Logged emails often carry live credentials: password-reset and login links, magic links, email-verification
links and one-time codes. Anything FluentSuite shows from a logged email (`smtp_email_detail` bodies, resend
preview subjects and samples) masks:

- URLs carrying `key=`, `token=`, `action=rp` / `action=resetpass`, or a login nonce (for example `_wpnonce=`,
  `nonce=`), and links whose path looks like a reset, login, magic-link or verification link;
- anything that looks like a one-time code (for example "Your code is 482913", "OTP: 4829-13").

A masked link keeps its host so the user can still tell what it was, for example
`https://shop.example.com/wp-login.php?[masked]`. Tests cover each pattern.

### Not included, on purpose

- Changing connections, credentials or API keys.
- Turning simulate mode or logging on or off. On a live site that would silently stop or flood all of the
  site's email.
- Slack, Telegram, Discord and Pushover notification setup.
- A general "send any email" tool. FluentSuite should not become a mail relay.

### Extras ✅

- A skill, `smtp-delivery-troubleshooting`: status, then report, then detail, then the likely fix, then
  resend only on a yes.
- The action-preview view (MCP Apps) for the resend, test-email and delete previews.

### How the sending tools stay safe

- **Three switches.** FluentSuite's `writes.enabled`, its `writes.allowSending`, and the site's
  `FLUENTSUITE_BRIDGE_ALLOW_SENDING`. Without the first two the tools are not listed; without the third
  they refuse with the fix, and the bridge refuses too.
- **Preview, then token.** Both sending tools always preview and always need the confirmation token. The
  resend token covers the exact ids previewed: if a new failure lands in the date range, the token no longer
  matches and nothing is sent.
- **Resend rules, enforced twice.** The tool and the bridge both refuse anything not `failed`. The bridge uses
  FluentSMTP's `check_realtime` resend, so an email that fails again stays `failed` (FluentSMTP's plain retry
  would mark it sent).
- **Delete.** Exactly one criterion; the token covers the previewed count, and the bridge refuses if more
  logs match at delete time.

### Bridge routes

| Route | Kind |
|---|---|
| `GET smtp/status`, `GET smtp/logs` (also `ids[]`), `GET smtp/logs/{id}`, `GET smtp/report` | read |
| `POST smtp/test-email`, `POST smtp/resend` | sending: refuse unless `FLUENTSUITE_BRIDGE_ALLOW_SENDING` |
| `POST smtp/logs/delete` (`dry_run` by default, `expected_count` to delete) | destructive |

## Test site

FluentSMTP 2.4.1 runs in simulate mode on the test site, so nothing is ever sent. See
[test-site.md](test-site.md#email-nothing-leaves-the-box).
