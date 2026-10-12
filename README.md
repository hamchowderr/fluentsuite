# FluentSuite

An MCP server **for Fluent** WordPress plugins: FluentCRM first, then FluentSMTP, Fluent Forms,
FluentBooking, FluentCart, Fluent Support and FluentAffiliate.

- **Task-shaped tools.** About a dozen tools per product, each doing a whole job ("show me
  everything about this contact"), not hundreds of endpoint wrappers.
- **Safe by default.** Read-only unless you turn writes on. Every write previews first. Bulk,
  destructive and email-sending actions need explicit confirmation.
- **MCP Apps.** In-chat views such as a contact card, in hosts that support them.
- **Skills.** Playbooks (`SKILL.md`) shipped with the server over the MCP Skills extension.
- **Current MCP.** Built on the MCP 2026-07-28 specification: stateless, over stdio or Streamable HTTP.

> **Not affiliated with WPManageNinja.** FluentSuite is an independent project. "FluentCRM",
> "FluentSMTP", "Fluent Forms" and the other product names belong to WPManageNinja; they are used
> here only to say which plugins FluentSuite works with.

**Status:** early. FluentCRM's 15 tools (8 read, 6 write, plus opt-in sending) are in place. See
[docs/crm-tools.md](docs/crm-tools.md). FluentSMTP's 7 tools (4 read, a log delete, plus opt-in test email
and resend) are in place. See [docs/smtp-tools.md](docs/smtp-tools.md). Fluent Forms' 8 tools (5 read, 3 write) and
its inbox-triage skill are in place, with privacy rules for entries. See [docs/forms-tools.md](docs/forms-tools.md).

## What you need

- A WordPress site over HTTPS with FluentCRM installed.
- A WordPress user with FluentCRM access (an administrator, or a user with FluentCRM permissions on
  FluentCRM Pro) and an **Application Password** for that user: *Users → Profile → Application
  Passwords*, or FluentCRM's REST API settings screen.
- Node.js 22 or newer and pnpm 10 (`corepack enable`).
- For FluentSMTP: the **FluentSuite Bridge** plugin on the site (see below).

### FluentSMTP needs the FluentSuite Bridge plugin

FluentSMTP has no REST API (its screens use `admin-ajax` with a browser cookie), so FluentSuite ships a
small companion plugin, [`wordpress/fluentsuite-bridge`](wordpress/fluentsuite-bridge), that adds REST
routes under `/wp-json/fluentsuite/v1/smtp/`. Copy that folder to `wp-content/plugins/` and activate
**FluentSuite Bridge**. It:

- uses FluentSMTP's own permission check (administrators by default);
- never returns API keys, passwords or tokens (connection settings go through an allowlist);
- keeps sending routes off unless `define('FLUENTSUITE_BRIDGE_ALLOW_SENDING', true);` is in `wp-config.php`.

## Install

FluentSuite is not on npm yet. Build it from source:

```sh
git clone https://github.com/hamchowderr/fluentsuite.git
cd fluentsuite
pnpm install
pnpm build
```

The server binary is `packages/server/dist/bin.js`. A FluentCRM-only binary is at
`packages/crm/dist/bin.js`; it behaves the same with only the CRM tools.

### Claude Desktop

Add this to `claude_desktop_config.json` (*Settings → Developer → Edit Config*), using the
absolute path to your clone:

```json
{
  "mcpServers": {
    "fluentsuite": {
      "command": "node",
      "args": ["/absolute/path/to/fluentsuite/packages/server/dist/bin.js", "--stdio"],
      "env": {
        "FLUENTSUITE_SITE_URL": "https://your-site.example",
        "FLUENTSUITE_WP_USER": "your-wordpress-username",
        "FLUENTSUITE_WP_APP_PASSWORD": "xxxx xxxx xxxx xxxx xxxx xxxx"
      }
    }
  }
}
```

Restart Claude Desktop. Try: *"What do we know about jane@example.com in FluentCRM?"*

### Claude Code

```sh
claude mcp add fluentsuite \
  -e FLUENTSUITE_SITE_URL=https://your-site.example \
  -e FLUENTSUITE_WP_USER=your-wordpress-username \
  -e FLUENTSUITE_WP_APP_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx" \
  -- node /absolute/path/to/fluentsuite/packages/server/dist/bin.js --stdio
```

### Hosted (Streamable HTTP)

```sh
export FLUENTSUITE_SITE_URL=https://your-site.example
export FLUENTSUITE_WP_USER=your-wordpress-username
export FLUENTSUITE_WP_APP_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx"
export FLUENTSUITE_HTTP_HOST=0.0.0.0
export FLUENTSUITE_HTTP_PORT=3333
export FLUENTSUITE_HTTP_TOKEN="$(openssl rand -hex 32)"   # required off loopback
node packages/server/dist/bin.js --http
```

The MCP endpoint is `http://<host>:3333/mcp`; clients send `Authorization: Bearer <token>`.
`GET /healthz` answers `{"ok":true}` for load balancers. The server is stateless, so you can run
several instances behind a load balancer; set the same `FLUENTSUITE_CONFIRM_SECRET` on all of them.
Put it behind HTTPS (a reverse proxy) and add the public host name to
`FLUENTSUITE_HTTP_ALLOWED_HOSTS`.

## Configuration

Environment variables, or a JSON file passed with `--config` / `FLUENTSUITE_CONFIG`
(environment variables win). See [.env.example](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `FLUENTSUITE_SITE_URL` | required | WordPress site root, `https://…` |
| `FLUENTSUITE_WP_USER` | required | WordPress username |
| `FLUENTSUITE_WP_APP_PASSWORD` | required | Application Password for that user |
| `FLUENTSUITE_PRODUCTS` | `crm` | Comma-separated products to serve: `crm`, `smtp`, `forms` |
| `FLUENTSUITE_WRITES` | `false` | Allow write tools. Off means read-only. |
| `FLUENTSUITE_ALLOW_SENDING` | `false` | Allow tools that send email: `crm_send_campaign`, `smtp_send_test_email`, `smtp_resend_failed_emails`. Needs writes on too. |
| `FLUENTSUITE_FORMS_REDACT_FIELDS` | none | Extra field-name words whose Fluent Forms entry values always show `[redacted]` (comma-separated, on top of the built-in list) |
| `FLUENTSUITE_BULK_THRESHOLD` | `10` | Writes touching more records need explicit confirmation |
| `FLUENTSUITE_CONFIRM_SECRET` | random | HMAC secret for confirmation tokens; set it for multi-instance hosting |
| `FLUENTSUITE_TIMEOUT_MS` | `20000` | WordPress request timeout |
| `FLUENTSUITE_RETRIES` | `2` | Retries for read requests on 429/5xx/network errors |
| `FLUENTSUITE_HTTP_HOST` / `_PORT` / `_PATH` | `127.0.0.1` / `3333` / `/mcp` | HTTP listener |
| `FLUENTSUITE_HTTP_TOKEN` | none | Bearer token; required when the host is not loopback |
| `FLUENTSUITE_HTTP_ALLOWED_HOSTS` | none | Extra accepted `Host` header values |
| `FLUENTSUITE_ALLOW_INSECURE_HTTP` | `false` | Allow `http://` sites (local development only) |
| `FLUENTSUITE_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` (logs go to stderr) |

## Safety model

- **Read-only by default.** With writes off, write tools are not even listed.
- **Preview first.** Write tools default to `dry_run=true` and show exactly what would change.
- **Confirmation.** Bulk (over the threshold), destructive and email-sending actions need a
  `confirmation_token` from the preview, valid for 10 minutes and only for those exact arguments.
  The assistant has to show you the preview and get your yes first.
- **Sending email is a separate switch.** `crm_send_campaign` exists only when both
  `FLUENTSUITE_WRITES` and `FLUENTSUITE_ALLOW_SENDING` are `true`. It always previews the subject,
  recipient count and a sample first, needs the confirmation token for both send-now and schedule,
  and refuses to send if the audience has grown past the previewed count. Drafting a campaign
  (`crm_draft_campaign`) never sends.
- **FluentSMTP sending has a third lock, on the site.** `smtp_send_test_email` and
  `smtp_resend_failed_emails` also need `FLUENTSUITE_BRIDGE_ALLOW_SENDING` in the site's `wp-config.php`.
  A resend only ever goes to the email's original recipients, and only for emails that failed.
- **Never re-marketing.** No tool re-subscribes or adds to lists a contact who unsubscribed, bounced
  or complained.
- **Secrets in logged emails stay hidden.** The FluentSMTP tools mask password-reset, login, magic and
  verification links and one-time codes in everything they show from the email log.
- **Form entries follow privacy rules.** Lists show only a name, an email and the date. One entry shows uploads
  as file names only, never password fields, IP addresses or browsers, and `[redacted]` for sensitive-looking
  fields (tax id, card, passport, …; extend the list with `FLUENTSUITE_FORMS_REDACT_FIELDS`). No tool submits a
  form or creates an entry, so none of them sets off form notifications or integrations.
- **No secrets or customer data in logs.**

## Development

```sh
pnpm install
pnpm check        # lint + typecheck + tests
pnpm test         # tests only (server, agent and end-to-end)
pnpm build        # emit dist/ and build the MCP Apps views
```

No live site is needed: tests run against an in-memory FluentCRM REST API, responses recorded
from our test site, and a mocked model. See [docs/test-site.md](docs/test-site.md) for the test site.
See [docs/architecture.md](docs/architecture.md) for the design decisions and
[CHANGELOG.md](CHANGELOG.md) for what changed.

## License

[MIT](LICENSE). FluentSuite is free and will stay free.
