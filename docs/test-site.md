# Test site

A throwaway WordPress site with **fictional** data, for recording fixtures and running the live
contract tests. It is not a business site and holds no real people: every contact email is
`@example.com`.

| | |
|---|---|
| URL | `$FLUENTSUITE_TEST_SITE_URL` (HTTPS via Coolify) |
| wp-admin | `$FLUENTSUITE_TEST_SITE_URL/wp-admin`, user `admin` |
| Admin password | A strong random password (at least 32 characters; `site.py create` generates 48), stored only in the test service's Coolify variable `WP_ADMIN_PASSWORD` (Coolify → the test project → **fluentsuite-test** → Environment Variables). Never a simple or reused password, and never in the repo, chat, logs or issues. |
| MCP user | `fluentsuite-mcp` (administrator, so FluentCRM free allows REST access). Its Application Password is the Coolify variable `FLUENTSUITE_MCP_APP_PASSWORD` |
| Stack | wordpress:6.8-php8.3-apache (WordPress 6.8.3, PHP 8.3.28) + mariadb:11 |

## Plugins

| Plugin | Version | Source | Notes |
|---|---|---|---|
| FluentCRM | 3.2.5 | wordpress.org | Free core. |
| FluentCRM Pro (`fluentcampaign-pro`) | 3.2.5 | Copied from the owner's licensed hub site (`site.py copy-pro`, `FLUENTSUITE_HUB_URL`) | Active. The license is **not** activated here, so the test site never uses a license seat; Pro features work without it, and wp-admin shows a "license needs to be activated" notice. |
| FluentBooking Pro (`fluent-booking-pro`) | 2.5.0 | Copied from the hub | Installed, inactive until the FluentBooking module adds the free FluentBooking plugin. |
| FluentSMTP (`fluent-smtp`) | 2.4.1 | wordpress.org (`smtp` step) | **Simulate mode**: nothing is ever sent. See [Email: nothing leaves the box](#email-nothing-leaves-the-box). |
| FluentSuite Bridge (`fluentsuite-bridge`) | from this repo | `wordpress/fluentsuite-bridge`, `bridge` step | REST routes for FluentSMTP. Sending stays off (`FLUENTSUITE_BRIDGE_ALLOW_SENDING` is not set). |
| Fluent Forms (`fluentform`) | 6.2.15 | wordpress.org (`forms` step) | Four test forms and fictional entries. Activation also adds its two empty demo forms. |
| FluentBooking, FluentCart, Fluent Support, FluentAffiliate | — | wordpress.org | Added as their FluentSuite modules are built (add the slug to the `plugins` step). |

FluentCRM 3.2.5 is newer than the 2.9.84 source that
[reference/fluentcrm-rest-api.md](reference/fluentcrm-rest-api.md) was written from. The shapes the
current tools use are unchanged (verified by the recorded fixtures); the paginator now also carries
`first_page_url`, `last_page_url`, `links` and `path`.

## Seed data

[`scripts/test-site/remote/seed.php`](../scripts/test-site/remote/seed.php), deterministic (fixed
random seed), skipped if already seeded:

- 50 contacts (`firstname.lastnameN@example.com`) with mixed statuses (mostly subscribed, some
  pending, unsubscribed and bounced), lead/customer types, sources and countries, created over the
  last 120 days;
- tags following the [tagging conventions](../packages/crm/skills/crm-tagging-conventions/SKILL.md)
  (`VIP`, `int:*`, `src:*`, `stage:*`, `tmp:*`), lists (Newsletter, Product updates, Webinar
  attendees), custom fields `plan` and `company_size`, and some notes;
- one **draft** campaign, never scheduled or sent;
- one **draft** email sequence (Pro), "New lead nurture (test)", with two emails (2 and 4 days). Nobody is
  enrolled, so nothing sends. Created by `site.py seed-pro` through the REST API.
- 38 FluentSMTP email log rows (26 sent, 12 failed) to fictional `@example.com` people, over the last ~15 days,
  from sources FluentCRM, FluentCart, WordPress (password resets), Fluent Forms and FluentBooking, with three
  kinds of failure (connection refused, authentication, recipient rejected). Two of them carry **fake**
  credentials (a password-reset link with a made-up key, and a made-up one-time code) for testing secret
  masking. Seeded by [`remote/smtp.php`](../scripts/test-site/remote/smtp.php).

- Fluent Forms: four forms built from Fluent Forms' own templates (Contact, Newsletter signup, Event
  registration, Donation, each titled "… (test)") and 62 fictional entries (24, 18, 12 and 8) to `@example.com`,
  spread over about 90 days, with read, unread, trashed and favorite entries. Entries are inserted **directly**
  into Fluent Forms' tables, so no submission hooks ran: no notifications, feeds or webhooks. For testing the
  PII rules, the Contact form has a file-upload field (fake URLs that point nowhere, every other entry) and a
  sensitive-looking "Tax ID" field (`FAKE-TAX-…`); two messages carry a fake one-time code and a fake reset
  link; IPs are from the 192.0.2.0/24 documentation range. Donation entries carry fake Stripe payment columns
  (no transactions, no keys). Seeded by [`remote/forms.php`](../scripts/test-site/remote/forms.php).

## Email: nothing leaves the box

- `FLUENTMAIL_SIMULATE_EMAILS` is `true` in `wp-config.php`, set by the `smtp` step **before** FluentSMTP is
  activated. In simulate mode FluentSMTP hands no mail to any provider. It only writes a log row ("Sending
  was simulated"). This covers every plugin's mail, FluentCRM's included. FluentSMTP's own
  `simulate_emails` setting is on as well.
- The only connection is SMTP to `127.0.0.1` port `1`, so even with simulate mode off nothing could be
  delivered.
- The only sender addresses are `noreply@example.com` and `wordpress@example.com`. Every seeded recipient is
  `@example.com`.
- Never turn simulate mode off on this site. `site.py smtp-status` prints the flag, the bridge's sending lock,
  the FluentSMTP version and the log counts.
- The bridge's sending lock (`FLUENTSUITE_BRIDGE_ALLOW_SENDING`) is **off**. `site.py bridge-sending on` turns
  it on for a manual test of the sending tools and refuses unless simulate mode is on; turn it `off` again
  afterwards and restore any rows a test changed.

## How it's built

[`scripts/test-site/site.py`](../scripts/test-site/site.py) drives everything through the Coolify
API, modelled on the waas-plugins test storefront:

- One Coolify **Service** from [`compose.yml`](../scripts/test-site/compose.yml); database passwords
  are generated by Coolify.
- **Commands** run as on-demand scheduled tasks in the `wordpress` container. Coolify keeps only
  255 characters of a task command, so the work lives in
  [`remote/setup.sh`](../scripts/test-site/remote/setup.sh). Tasks run as root; the `wp` wrapper
  drops to `www-data`.
- **Task output comes back empty**, so a step that must return something (the Application Password,
  versions) writes it to an unguessable `fs-<random>.txt` under `wp-content/uploads`; the script
  fetches it once and deletes it straight away.
- **Scripts reach the container** through an `FS_PKG` variable, 20 KB per restart, then the variable
  is removed.
- **Variables** are only ever set from known values. Coolify's GET returns null values, so nothing
  is round-tripped. `PATCH /envs` only updates existing variables; new ones are created with POST.
- Right after a restart, Coolify can report the service healthy just before the container restarts
  once more. Task steps right after a restart retry once.

## Use it

```sh
# Recreate from scratch (needs Coolify API access; the proxy in Claude sessions injects it)
scripts/test-site/site.py create           # generates a random 48-character admin password, stored only in Coolify
scripts/test-site/site.py push
scripts/test-site/site.py setup            # bootstrap install plugins smtp bridge forms seed mcp-user
scripts/test-site/site.py apppass <file>   # new Application Password → Coolify variable + <file> (0600); older ones are revoked
scripts/test-site/site.py copy-pro         # Pro plugins from the hub site (read only: temp archive, fetched, deleted)
scripts/test-site/site.py seed-pro <file>  # the draft sequence
scripts/test-site/site.py versions
scripts/test-site/site.py smtp-status      # simulate flag (must be 1), FluentSMTP version, log counts
scripts/test-site/site.py forms-status     # Fluent Forms version and entries per test form

# Record fixtures (GET only; refuses unless FLUENTSUITE_LIVE_SITE_URL equals FLUENTSUITE_TEST_SITE_URL;
# scrubs host names, hashes and IPs)
FLUENTSUITE_LIVE_SITE_URL="$FLUENTSUITE_TEST_SITE_URL" \
FLUENTSUITE_LIVE_WP_USER=fluentsuite-mcp \
FLUENTSUITE_LIVE_APP_PASSWORD_FILE=<file> \
node scripts/record-fixtures.mjs
node scripts/record-smtp-fixtures.mjs     # FluentSMTP through the bridge, same variables
node scripts/record-forms-fixtures.mjs    # Fluent Forms (never opens an entry, so nothing is marked read)

# Live contract tests (read-only)
FLUENTSUITE_LIVE_SITE_URL=… FLUENTSUITE_LIVE_WP_USER=fluentsuite-mcp FLUENTSUITE_LIVE_APP_PASSWORD=… \
pnpm vitest run packages/crm/test/live
```

Recorded fixtures live in `packages/crm/test/fixtures/recorded/`; `recorded-contract.test.ts` runs
the real tools against them in normal CI, offline. Re-record when FluentCRM is updated.

Remove everything: `scripts/test-site/site.py remove` (deletes the service with its volumes, then
the project).

## Owner steps

1. **Turn on the nightly live contract run (optional).** In GitHub → hamchowderr/fluentsuite →
   Settings → Secrets and variables → Actions, add:
   - `FLUENTSUITE_LIVE_SITE_URL` = the test site's URL (the value of `FLUENTSUITE_TEST_SITE_URL`)
   - `FLUENTSUITE_LIVE_WP_USER` = `fluentsuite-mcp`
   - `FLUENTSUITE_LIVE_APP_PASSWORD` = the value of the Coolify variable `FLUENTSUITE_MCP_APP_PASSWORD`
     (click the eye icon to show it)

   The **Live contract** workflow then runs nightly and on demand. Without the secrets it skips.
2. **Nothing to do for Pro.** The Pro plugins are copied from the hub and run unlicensed here on
   purpose. Don't activate the license on this site.

## Configuration

`site.py` and the recorders read everything about the infrastructure from environment variables, so nothing about
it lives in the repo:

| Variable | Used by | Meaning |
|---|---|---|
| `COOLIFY_URL` | `site.py` | Coolify base URL |
| `COOLIFY_TOKEN` | `site.py` | Coolify API token (not needed where a proxy injects credentials) |
| `FLUENTSUITE_TEST_SITE_URL` | `site.py`, recorders | The throwaway test site's URL, `https://…` |
| `COOLIFY_SERVER_UUID` | `site.py create` | The Coolify server to create the service on |
| `FLUENTSUITE_TEST_PROJECT_UUID` | `site.py` | The test project (optional; found by the name `FluentSuite (test)` otherwise) |
| `FLUENTSUITE_TEST_SERVICE_UUID` | `site.py` | The test service (optional; found by the name `fluentsuite-test` otherwise) |
| `FLUENTSUITE_TEST_ADMIN_PASSWORD` | `site.py create` | Optional; at least 32 random characters. Leave it unset and `create` generates one |
| `FLUENTSUITE_HUB_URL` | `site.py copy-pro` | The owner's licensed hub site that Pro plugins are copied from |
| `FLUENTSUITE_HUB_SERVICE` | `site.py copy-pro` | The hub's Coolify service name |
| `FLUENTSUITE_LIVE_SITE_URL`, `FLUENTSUITE_LIVE_WP_USER`, `FLUENTSUITE_LIVE_APP_PASSWORD(_FILE)` | recorders, live tests | Where and as whom to record or run the live tests |

The recorders refuse to run unless `FLUENTSUITE_LIVE_SITE_URL` equals `FLUENTSUITE_TEST_SITE_URL`, so a live URL
that points at a real site is never recorded from.
