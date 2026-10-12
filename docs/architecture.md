# FluentSuite architecture

FluentSuite is an MCP server for the WPManageNinja "Fluent" WordPress plugins (FluentCRM,
FluentSMTP, Fluent Forms, FluentBooking, FluentCart, Fluent Support, FluentAffiliate). It is an
independent project, not affiliated with or endorsed by WPManageNinja.

This document is a set of short ADRs (architecture decision records). Each one says what was
decided, why, and what it costs. Pinned versions are listed at the end.

```
                 ┌─────────────── fluentsuite (one binary) ───────────────┐
 Claude Desktop ─┤ stdio ──┐                                              │
 Claude Code     │         ├─► server factory ─► products (crm, smtp, …)  │──► WordPress REST API
 Hosted clients ─┤ HTTP ───┘     │                 │ tools / views / skills│    (Application Password)
                 │               └─ safety guard, logger, WP client ──────┘
                 └────────────────────────────────────────────────────────┘
```

## ADR-001: Build on MCP 2026-07-28, stateless

**Decision.** Target the 2026-07-28 protocol revision: no `initialize` handshake, `server/discover`,
per-request `_meta` carrying protocol version and client capabilities, no protocol sessions. The
server is stateless: Streamable HTTP builds a fresh server instance per request; stdio builds one
per connection.

**Why.** It is the current spec. Stateless servers scale behind any load balancer and have no
session store to secure. Cross-call state we need (pagination, confirmations) is carried in
server-minted handles passed back as ordinary tool arguments, as SEP-2567 recommends.

**How.** `@modelcontextprotocol/server` 2.3.1 implements the 2026-07-28 era: `createMcpHandler`
for HTTP and `serveStdio` for stdio, both taking a factory. Both also serve 2025-era clients from
the same factory (the SDK's `legacy: 'stateless'` default), so older hosts keep working.

**Cost.** Server-to-client requests (sampling, elicitation) now use the multi round-trip pattern
(MRTR). We do not need them yet; confirmations use tokens instead (ADR-005).

## ADR-002: TypeScript monorepo, one binary, products switched on by config

**Decision.** A pnpm workspace with strict TypeScript:

| Package | Contents |
|---|---|
| `packages/core` (`@fluentsuite/core`) | WordPress REST client, config, errors, paging, safety layer, logging/redaction, tool registration, MCP Apps UI kit, Skills loader, transports, CLI, test harness |
| `packages/crm` (`@fluentsuite/crm`) | FluentCRM tools, views, skills; standalone bin `fluentsuite-crm` |
| `packages/server` (`fluentsuite`) | The combined binary; lists every product module |
| later: `packages/smtp`, `forms`, … | One package per product |

A product is plain data (`Product`: id, title, instructions, a tool factory, views, skills). The
combined binary and each standalone binary are assembled by the same `createServerFactory`, so a
product behaves the same alone or combined. `FLUENTSUITE_PRODUCTS=crm,smtp` picks what is served.

Workspace packages resolve to their TypeScript sources through a custom export condition
(`@fluentsuite/source`), so typecheck and tests never need a build step; `pnpm build` emits `dist/`.

**Cost.** Tool names must be globally unique across products, so every tool carries a product
prefix (`crm_`, `smtp_`, …).

## ADR-003: WordPress REST client with Application Passwords

**Decision.** Talk to `/wp-json/` with HTTP Basic auth using a WordPress Application Password.
The client (`WordPressClient`) adds: per-request timeouts merged with MCP cancellation, retries
with backoff for **GET only** (writes never retry, to avoid double effects), PHP-style query
encoding (`tags[]=1`), JSON parsing that explains HTML/PHP-notice responses, optional zod
validation of responses, and typed errors.

**Why.** Application Passwords are core WordPress, revocable per application, and need no
plugin. FluentCRM's own "REST API keys" screen creates exactly this.

**Errors.** Every failure becomes a `FluentSuiteError` with a stable `code` (`auth_failed`,
`not_found`, `rate_limited`, …), a redacted, size-capped message, and a hint for the model. Tools
return these as `isError` results; they never throw protocol errors for business failures.
Product APIs translate plugin quirks (FluentCRM answers an unknown contact with HTTP 422) into the
right code.

**Cost.** HTTPS is required (WordPress refuses Application Passwords over plain HTTP outside
local environments). `site.allowInsecureHttp` exists for local development only.

## ADR-004: Task-shaped tools, short outputs, opaque cursors

**Decision.** Roughly 10–15 tools per product, each doing a whole job (for example "contact
profile by email" makes three REST calls and returns one answer). Inputs are tight zod schemas.
Outputs are short human-readable text **plus** `structuredContent` validated by an output schema.
Lists use opaque, stateless cursors: base64url JSON holding the next page and a fingerprint of the
query, so a cursor cannot be replayed against a different search.

**Why.** Endpoint-wrapper servers expose hundreds of tools, which wastes context and makes models
chain many calls. Task-shaped tools are fewer, easier to choose between, and easier to make safe.
Tools are listed in a stable (sorted) order, as the spec recommends for prompt caching.

**Annotations.** Read tools: `readOnlyHint: true`. Write tools: `readOnlyHint: false`, with
`destructiveHint`/`idempotentHint` set per tool. All tools: `openWorldHint: false`.

## ADR-005: Safe by default

1. **Read-only by default.** Write tools are not registered at all unless `writes.enabled` is
   true, so a read-only server never advertises them.
2. **Dry run first.** Every write tool takes `dry_run` (default `true`) and returns a preview of
   exactly what would change. Nothing changes until the same call is repeated with
   `dry_run=false`.
3. **Explicit confirmation for risky writes.** Bulk changes (more records than
   `writes.bulkThreshold`, default 10), destructive changes and anything that sends email need a
   `confirmation_token`. The preview mints it: an HMAC over the tool name, the exact arguments
   (minus the control fields) and an expiry (default 10 minutes). The executing call must match
   the previewed call exactly. Tokens are stateless; set `writes.confirmSecret` when several
   instances share traffic.
4. **Never send email without confirmation.** Sending tools are always "needs confirmation", and
   they are not even listed unless `writes.allowSending` is on as well as `writes.enabled`. The send
   token is bound to the previewed recipient count, and the send is refused if the audience grew.
   No tool re-subscribes, or adds to lists, contacts who unsubscribed, bounced or complained.
5. **No secrets or PII in logs.** Logs go to stderr as JSON lines. The WP client logs only method,
   route shape (`/subscribers/:id`), status and timing: never query strings, bodies or
   credentials. All log messages and fields pass through redaction (emails masked, auth headers,
   Application Passwords and URL credentials removed). Config errors name fields, never values.
6. **Hosted HTTP is locked down.** Loopback binds get Host/Origin checks (DNS-rebinding
   protection). Non-loopback binds refuse to start without a bearer token
   (`FLUENTSUITE_HTTP_TOKEN`), compared in constant time.

**Why tokens rather than elicitation.** Elicitation under 2026-07-28 uses MRTR, and host support
varies. A token works in every host, keeps the server stateless, and doubles as the payload for
the MCP Apps "Approve" button (ADR-006). Elicitation can be added later as a nicer path.

**Cost.** A risky write takes two calls. That is intended.

## ADR-006: MCP Apps for in-chat UI

**Decision.** Use the official MCP Apps extension (`io.modelcontextprotocol/ui`, SEP-1865) via
`@modelcontextprotocol/ext-apps` 2.0.3. A view is one self-contained HTML file (script and CSS
inlined, no remote loads, empty CSP domain lists) served as a `ui://` resource with MIME type
`text/html;profile=mcp-app`. Tools link to it with `_meta.ui.resourceUri`.

**UI kit.** `packages/core/ui/kit.ts` (browser side: connect, follow host theme variables, render
`structuredContent` with an escaping `h()` helper) and `packages/core/ui/base.css` (styles built
on the host's CSS variables). `packages/core/scripts/build-views.mjs` bundles each view with
esbuild into `ui-dist/`. Views never get data the text result does not also carry, so hosts
without MCP Apps lose only the visuals.

**CRM views.** Contact card, and an action preview used by the segment preview and every bulk or
campaign dry run. Its Approve button re-calls the same tool through the host with `dry_run=false`
and the confirmation token; the server verifies the token exactly as for a model-made call, so the
view adds convenience, not authority. A browser test (headless Chromium, hosted by the official
ext-apps `AppBridge`) checks the Approve and Cancel paths.

**Cost.** Each view bundles the ext-apps `App` class, which pulls in the MCP client SDK and zod:
about 600 KB per view before compression. Acceptable for now; a lighter bridge is a possible
follow-up.

## ADR-007: Skills over MCP, implemented in core

**Decision.** Ship playbooks as Agent Skills (`SKILL.md` with YAML frontmatter) using the official
Skills extension (`io.modelcontextprotocol/skills`, SEP-2640, Final). Each product keeps them in
`packages/<product>/skills/<name>/`.

**Gap.** The TypeScript SDK does not implement the Skills extension yet (upstream work is tracked
in typescript-sdk#2798, PR #2818). FluentSuite implements the server side in
`packages/core/src/skills.ts`:

- loads skills at startup and fails fast on invalid frontmatter or a name/directory mismatch;
- serves every file through `resources/read` as `skill://<name>/<path>`;
- registers `skills/list` and `skills/get` with SHA-256 digests and byte sizes computed from the
  exact bytes served, plus `resultType`, `ttlMs` and `cacheScope`;
- declares `extensions["io.modelcontextprotocol/skills"] = { directoryRead: false }`;
- answers an unknown skill URI with `-32602`.

When the SDK ships native support, this module should be replaced by it.

**Naming.** Skill names carry the product prefix (`crm-tagging-conventions`) and must be unique
across products; startup fails on duplicates.

## ADR-008: Testing without a live site

Three layers, all in Vitest, no Postman:

1. **Server tests** (fast, in-process). A real MCP client talks the 2026-07-28 protocol to the
   real server through the HTTP handler's `fetch`, with no port. The server's WordPress client is
   pointed at `MockWordPress`, an in-memory REST API that checks Basic auth, records every request
   and answers unknown routes with WordPress's real `rest_no_route` 404. Product fixtures are
   shaped from the plugin's REST behaviour: for FluentCRM see
   [reference/fluentcrm-rest-api.md](reference/fluentcrm-rest-api.md), written from the plugin
   source (Laravel paginators, `with[]` expansions, the 422 quirks). Data is fictional and uses
   `example.test`.
2. **Agent tests.** AIMock (`@copilotkit/aimock`) plays the model. A small agent loop in
   `@fluentsuite/core/testing` (`runAgent`) offers the server's real tool list, runs the tool calls
   the scripted model makes against the real server, and feeds results back. This proves the tool
   names, schemas and outputs work for a model, deterministically and without API keys.
3. **End to end.** The built `fluentsuite` binary is spawned over stdio (as Claude Desktop does)
   against the mock site served over real HTTP; the HTTP transport is tested on a real socket with
   bearer auth and Host checks.

CI (GitHub Actions) runs lint (Biome), typecheck, build and all tests on every PR.

4. **Recorded contract tests.** Responses recorded from the FluentSuite test site (a throwaway
   WordPress on Coolify with fictional data, see [test-site.md](test-site.md)) are scrubbed and
   committed; the real tools run against them offline in normal CI. A separate **Live contract**
   workflow (manual and nightly) runs the read-only tools against the test site itself.

## ADR-009: A companion plugin where a Fluent plugin has no REST API

**Context.** FluentSMTP's admin endpoints are `admin-ajax` actions guarded by a logged-in cookie and a
nonce. WordPress Application Passwords (ADR-003) authenticate REST requests only, so FluentSuite cannot
reach them. FluentSMTP registers no REST routes besides its Outlook OAuth callback.

**Decision.** Ship **FluentSuite Bridge** (`wordpress/fluentsuite-bridge`, PHP, MIT) with REST routes under
`fluentsuite/v1/smtp/*` that read FluentSMTP's own data (its settings option and log table) the way its
screens do. Approved by the owner.

- Permission is FluentSMTP's own `fluentMailCurrentUserCanManage()`.
- Connection settings pass through an allowlist; credentials never leave the site.
- Stored values are unserialized with `allowed_classes => false`; every query is prepared.
- Sending routes (test email, resend) need a second, site-side switch: `FLUENTSUITE_BRIDGE_ALLOW_SENDING` in
  `wp-config.php`. Resends use FluentSMTP's `check_realtime` mode and never custom recipients.
- The action-preview MCP Apps view lives in `packages/core/ui` and is built by each product into its own
  `ui-dist`, served under its own `ui://<product>/action-preview.html`.
- Secret masking of email content (reset/login/magic/verification links, one-time codes) is done in the
  TypeScript package (`packages/smtp/src/mask.ts`) and covered by unit, recorded and live tests.

**Rejected.** Signing in with the real WordPress password to collect cookies and nonces: it needs the
real password, is fragile, and breaks the Application Password model. The other Fluent plugins on the
build list have REST APIs and need no bridge.

**Testing.** The offline mock (`packages/smtp/test/mock-bridge.ts`) computes searches and reports from
a recorded copy of the test site's log; recorded-contract tests check its answers equal the live bridge's.

## ADR-010: Fluent Forms through its REST API, with privacy rules for entries

**Context.** Fluent Forms has a real REST API (`fluentform/v1`), gated by its own per-form permissions. Entries hold
whatever people typed, plus IP address, browser and location. Two routes have side effects that a read or a write
tool must not trigger by accident: `GET submissions/{id}` marks unread entries as read, and `POST form-submit`
creates an entry, which fires notifications, integration feeds and webhooks.

**Decision.** Use the REST API directly (no bridge). Owner-approved privacy rules (`packages/forms/src/pii.ts`):
lists show only a name, an email and the date; one entry shows uploads as file names only, never password fields,
IP or browser, and `[redacted]` for fields whose name or label matches a sensitive word (built-in list plus
`forms.redactFields`); every other value goes through the shared secret masking (moved to `packages/core/src/mask.ts`).
One entry is found through the side-effect-free list route; `GET submissions/{id}` and `form-submit` are never
called, and the test mock records any call to them so tests can prove it.

## Pinned versions

| Package | Version | Why |
|---|---|---|
| `@modelcontextprotocol/server`, `client`, `core` | 2.3.1 | First SDK line with the 2026-07-28 era (`createMcpHandler`, `serveStdio`, `server/discover`) |
| `@modelcontextprotocol/node` | 2.1.1 | Node HTTP adapter and Host/Origin guards |
| `@modelcontextprotocol/ext-apps` | 2.0.3 | MCP Apps for SDK 2.x |
| `@copilotkit/aimock` | 1.45.0 | Mock model for agent tests |
| `zod` | 4.6.6 | Schemas (the SDK requires zod 4) |
| `typescript` | 6.0.3 | Strict typecheck and build (7.x, the native compiler, can come later) |
| `vitest` | 5.0.3 | Tests |
| `@biomejs/biome` | 2.5.15 | Lint and format |
| `esbuild` | 0.28.2 | View bundling |
| Node.js | 22 LTS | Runtime |

## Not decided here

- **Hosted auth beyond a bearer token** (OAuth 2.1 per the MCP authorization spec). Needed before
  multi-tenant hosting.
- **Multiple WordPress sites per server.** One site per server for now.
