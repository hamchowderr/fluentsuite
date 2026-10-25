# FluentSuite: agent guide

An MCP server for the WPManageNinja "Fluent" WordPress plugins (FluentCRM, FluentSMTP, Fluent Forms, then FluentBooking, FluentCart, Fluent Support, FluentAffiliate). Independent, not affiliated with WPManageNinja. Decisions and pinned versions: `docs/architecture.md`; each product's tools: `docs/*-tools.md`.

| Folder | What's there |
|---|---|
| `packages/server` | The one binary (stdio and Streamable HTTP) |
| `packages/core` | WordPress REST client, safety guard, logger, shared UI |
| `packages/crm`, `smtp`, `forms` | One package per Fluent product: tools, MCP App views, skills |
| `wordpress/fluentsuite-bridge` | A small WordPress plugin for what the Fluent plugins' own REST APIs don't offer (FluentSMTP) |

## Building and testing

Node 22+ and pnpm 10. `pnpm install`, then `pnpm check` (Biome lint, typecheck, Vitest) before pushing. `docs/test-site.md` describes the live test site the contract workflow runs against.

## Rules for tools

- Task-shaped tools (one whole job each), not one tool per endpoint.
- Read-only unless writes are turned on. Every write previews first; bulk, destructive and email-sending actions need explicit confirmation. Keep personal data in form entries and contacts out of logs.
- Built on MCP 2026-07-28 with `@modelcontextprotocol/server` 2.x. Check npm for the newest release before changing or describing versions.

## Building for WordPress

The bridge plugin and anything that touches a WordPress site follow the WordPress skills in `.claude/skills/` (list in its README): `wp-plugin-development` for structure and security, `wp-rest-api` for routes and permission callbacks, `wp-abilities-api` if the bridge exposes abilities, `wp-plugin-directory-guidelines` before submitting to wordpress.org, `wp-env` or `wp-playground` for a local site.

## Rules for every change

- **Beads, every time.** Each piece of work gets a Beads issue before it starts (check for a duplicate first). Put the id in the branch, the PR and the status, and close the issue when the PR merges or the change is live. Run `bd` in the session doing the work; the SessionStart hook in `.claude/settings.json` loads the Dolt login, then `bd dolt push` syncs it. This repository's issues are in DoltHub `chowderr/fluentsuite`.
- **Pull requests:** open them ready for review, not as drafts, so CI runs. Merge a PR yourself once CI is green and the work was asked for.
- **No "WPCS" wording.** The old platform is gone. Say "the AnyPress API" or "the API's key and secret login". Don't add the word anywhere; existing identifiers that live sites depend on (plugin slugs such as `wpcs-waas-host`, update URLs) stay until a planned migration.
- **Public docs are for users.** READMEs and `docs/` explain how to use and run the code. Internal notes (server and Coolify ids, Beads, deployment steps) go in the obsidian-vault repository under `1. Projects/`. Never put how or why AnyPress started in public copy.
- **Verify before claiming.** Check npm, wordpress.org or the official docs before calling a version or spec "the latest", and check a fix on the running system before calling it fixed.
