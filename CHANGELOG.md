# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Fluent Forms write tools: `forms_update_entries` (read/unread, favorites, trash/restore; token for bulk, bound
  to the exact entries), `forms_add_entry_note`, `forms_delete_entries` (ids, trashed and older than N days, or an
  exact email; capped at 200; token bound to the count; says uploaded files go too). The `forms-inbox-triage` skill.
- Fluent Forms module (`@fluentsuite/forms`, `fluentsuite-forms`): read tools `forms_list`, `forms_form_summary`,
  `forms_find_entries`, `forms_entry_detail` and `forms_report`, with the owner-approved privacy rules (file names
  only, no passwords, IPs or browsers, `[redacted]` sensitive fields, `FLUENTSUITE_FORMS_REDACT_FIELDS`, shared
  secret masking). Reading an entry never marks it read. Secret masking moved to core.
- Test site: Fluent Forms 6.2.15 with four test forms and 62 fictional entries (inserted directly, so no
  notifications or feeds ran); `site.py forms-status`. Fluent Forms tool proposal in `docs/forms-tools.md`.
- MCP Apps action-preview view with Approve/Cancel for segment previews and write dry runs, tested
  in headless Chromium through the ext-apps `AppBridge`.
- Skills `crm-win-back-campaign` and `crm-new-lead-follow-up`.
- FluentSMTP module (`@fluentsuite/smtp`, `fluentsuite-smtp`): read tools `smtp_status`,
  `smtp_find_email_logs`, `smtp_email_detail` and `smtp_delivery_report`, with password-reset, login,
  magic and verification links and one-time codes masked in everything shown from the email log.
- FluentSMTP write tools: `smtp_delete_email_logs` (by ids, recipient or age; no delete-all), and, behind
  `allowSending` plus the bridge's `FLUENTSUITE_BRIDGE_ALLOW_SENDING`, `smtp_send_test_email` and
  `smtp_resend_failed_emails` (failed emails only, original recipients only, token bound to the exact
  emails previewed). The action-preview view (now shared in core) and the `smtp-delivery-troubleshooting`
  skill.
- FluentSuite Bridge WordPress plugin (`wordpress/fluentsuite-bridge`): REST read routes for FluentSMTP,
  which has no REST API of its own. Allowlisted settings, FluentSMTP's own permission check.
- Test site: FluentSMTP 2.4.1 in simulate mode (nothing is ever sent), a connection to 127.0.0.1:1 and
  fictional email log rows; `site.py smtp-status`.
- CRM write tools (dry run first, tokens for bulk/destructive): `crm_tag_contacts`,
  `crm_update_list_membership`, `crm_upsert_contact`, `crm_set_contact_status`, `crm_add_contact_note`,
  `crm_draft_campaign` (never sends).
- `crm_send_campaign`, behind its own `writes.allowSending` / `FLUENTSUITE_ALLOW_SENDING` switch (off by
  default): previews subject, count and sample; token bound to the previewed recipient count.
- CRM read tools: `crm_find_contacts`, `crm_tags_and_lists`, `crm_segment_preview`,
  `crm_campaign_overview`, `crm_sequence_overview` (Pro), `crm_recent_signups`, `crm_audience_summary`.
  Tags and lists are given by name; segments support exclusions. Tested offline against the recorded
  test-site dataset, with agent-level and live contract tests.
- Test site runs FluentCRM Pro (copied from the licensed hub site, license not activated) with a
  draft email sequence; Pro sequence responses are recorded as fixtures.
- Test WordPress site on Coolify (`scripts/test-site/`, `docs/test-site.md`): FluentCRM 3.2.5 with
  fictional seed data and a dedicated MCP user.
- Fixture recorder (`scripts/record-fixtures.mjs`), recorded contract tests, and an optional
  nightly **Live contract** workflow against the test site.
- MIT license.
- Beads issue tracking config (`.beads/`), matching the owner's other repos.
- Monorepo scaffold: pnpm workspace, strict TypeScript, Biome, Vitest, GitHub Actions CI
  (lint, typecheck, build, test).
- `@fluentsuite/core`:
  - WordPress REST client with Application Password auth, timeouts, GET-only retries,
    PHP-style query encoding and typed, redacted errors.
  - Config from `FLUENTSUITE_*` environment variables and/or a JSON file.
  - Opaque, stateless pagination cursors bound to the tool and query.
  - Safety layer: read-only by default, dry-run previews, HMAC confirmation tokens for bulk,
    destructive and email-sending writes.
  - Redacting JSON logger (stderr only).
  - Tool registration with annotations and `isError` results.
  - MCP Apps UI kit and view build script.
  - Skills over MCP (`skills/list`, `skills/get`, `skill://` resources with digests).
  - stdio and stateless Streamable HTTP transports (MCP 2026-07-28) with bearer auth and
    Host/Origin checks.
  - Test harness: in-process MCP client, mock WordPress REST API, and an agent loop for AIMock.
- `@fluentsuite/crm`: `crm_contact_profile` tool, contact card MCP App view,
  `crm-tagging-conventions` skill, and a standalone `fluentsuite-crm` binary.
- `fluentsuite`: the combined server binary.
- Docs: README, `docs/architecture.md` (ADRs), `docs/crm-tools.md` (proposed CRM tool list),
  `docs/reference/fluentcrm-rest-api.md` (FluentCRM REST notes used for fixtures).
