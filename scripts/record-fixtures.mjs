#!/usr/bin/env node
// Records FluentCRM REST responses from the test site into packages/crm/test/fixtures/recorded/, scrubbed.
//
//   FLUENTSUITE_TEST_SITE_URL=https://<your test site> \
//   FLUENTSUITE_LIVE_SITE_URL=$FLUENTSUITE_TEST_SITE_URL \
//   FLUENTSUITE_LIVE_WP_USER=fluentsuite-mcp \
//   FLUENTSUITE_LIVE_APP_PASSWORD_FILE=/path/to/file \
//   node scripts/record-fixtures.mjs
//
// Only GET requests. Only run against the FluentSuite test site, whose data is fictional (@example.com).
// Scrubbing replaces the site URL with https://crm.example.test, and blanks hashes, IPs and Gravatar URLs,
// so recordings contain nothing that identifies the host or any person.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/crm/test/fixtures/recorded");
const site = process.env.FLUENTSUITE_LIVE_SITE_URL?.replace(/\/+$/, "");
const user = process.env.FLUENTSUITE_LIVE_WP_USER;
const passwordFile = process.env.FLUENTSUITE_LIVE_APP_PASSWORD_FILE;
const password =
  process.env.FLUENTSUITE_LIVE_APP_PASSWORD ??
  (passwordFile ? readFileSync(passwordFile, "utf8") : undefined);
if (!site || !user || !password) {
  console.error(
    "Set FLUENTSUITE_LIVE_SITE_URL, FLUENTSUITE_LIVE_WP_USER and FLUENTSUITE_LIVE_APP_PASSWORD(_FILE).",
  );
  process.exit(1);
}
// Safety: record only from the site declared as the throwaway test site. A live URL that points anywhere else
// (a real business site, say) is refused.
const testSite = process.env.FLUENTSUITE_TEST_SITE_URL?.replace(/\/+$/, "");
if (!testSite || site !== testSite) {
  console.error(
    "Refusing to record: FLUENTSUITE_LIVE_SITE_URL must equal FLUENTSUITE_TEST_SITE_URL (the throwaway test site).",
  );
  process.exit(1);
}
const auth = `Basic ${Buffer.from(`${user}:${password.replace(/\s+/g, "")}`).toString("base64")}`;
const api = `${site}/wp-json/fluent-crm/v2`;

async function get(route) {
  const res = await fetch(`${api}/${route}`, {
    headers: { Authorization: auth, Accept: "application/json" },
  });
  return { status: res.status, body: await res.json() };
}

function scrub(value) {
  if (typeof value === "string") {
    return value
      .split(site)
      .join("https://crm.example.test")
      .replace(
        /https:\/\/(secure\.)?gravatar\.com\/avatar\/[^"\s]*/g,
        "https://www.gravatar.com/avatar/0?s=128&d=mm",
      )
      .replace(/^[a-f0-9]{32}$/, "0".repeat(32));
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === "ip" || k === "hash" || k === "email_hash" ? (v ? "redacted" : v) : scrub(v),
      ]),
    );
  }
  return value;
}

function save(name, route, recorded) {
  const body = scrub(recorded.body);
  writeFileSync(
    join(out, name),
    `${JSON.stringify({ route, status: recorded.status, body }, null, 1)}\n`,
  );
  console.error(`recorded ${name} (HTTP ${recorded.status})`);
}

mkdirSync(out, { recursive: true });
const list = await get("subscribers?per_page=3&page=1");
save("subscribers-list.json", "GET subscribers?per_page=3&page=1", list);
const first = list.body.subscribers.data[0];
const email = first.email;
if (!email.endsWith("@example.com")) {
  console.error("Unexpected non-example.com contact; refusing to record.");
  process.exit(1);
}
const withs = "with[]=stats&with[]=subscriber.custom_values";
save(
  "subscriber-show-by-email.json",
  `GET subscribers/0?get_by_email=<email>&${withs}`,
  await get(`subscribers/0?get_by_email=${encodeURIComponent(email)}&${withs}`),
);
save(
  "subscriber-not-found.json",
  "GET subscribers/0?get_by_email=nobody@example.com",
  await get("subscribers/0?get_by_email=nobody%40example.com"),
);
save(
  "subscriber-emails.json",
  "GET subscribers/<id>/emails?per_page=5&page=1",
  await get(`subscribers/${first.id}/emails?per_page=5&page=1`),
);
// Notes: pick a contact that has some, if any.
let noted = first.id;
for (const s of (await get("subscribers?per_page=50&page=1")).body.subscribers.data) {
  const n = await get(`subscribers/${s.id}/notes?per_page=3&page=1`);
  if (n.body.notes?.total > 0) {
    noted = s.id;
    break;
  }
}
save(
  "subscriber-notes.json",
  "GET subscribers/<id>/notes?per_page=3&page=1",
  await get(`subscribers/${noted}/notes?per_page=3&page=1`),
);
save("tags.json", "GET tags?per_page=20", await get("tags?per_page=20"));
save("lists.json", "GET lists", await get("lists"));
save("campaigns.json", "GET campaigns?per_page=5", await get("campaigns?per_page=5"));
save("dashboard-stats.json", "GET reports/dashboard-stats", await get("reports/dashboard-stats"));
// The whole fictional dataset, so offline tests can filter it like FluentCRM does (see mock-recorded-site.ts).
save(
  "dataset-subscribers.json",
  "GET subscribers?per_page=100&sort_by=id&sort_type=ASC",
  await get("subscribers?per_page=100&page=1&sort_by=id&sort_type=ASC"),
);
save(
  "dataset-tags.json",
  "GET tags?per_page=500",
  await get("tags?per_page=500&page=1&sort_by=title&sort_order=ASC"),
);
save(
  "dataset-campaigns.json",
  "GET campaigns?with[]=stats&per_page=50",
  await get("campaigns?with[]=stats&per_page=50&page=1"),
);
{
  const firstCampaign = (await get("campaigns?per_page=1&page=1")).body.campaigns?.data?.[0];
  if (firstCampaign) {
    save("campaign-show.json", "GET campaigns/<id>", await get(`campaigns/${firstCampaign.id}`));
    save(
      "campaign-overview-stats.json",
      "GET campaigns/<id>/overview_stats",
      await get(`campaigns/${firstCampaign.id}/overview_stats`),
    );
    save(
      "campaign-link-report.json",
      "GET campaigns/<id>/link-report",
      await get(`campaigns/${firstCampaign.id}/link-report`),
    );
  }
}
const to = new Date().toISOString().slice(0, 10);
const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
for (const kind of ["subscribers", "email-sents", "email-opens", "email-clicks"]) {
  save(
    `report-${kind}.json`,
    `GET reports/${kind}?date_range[]=<30 days ago>&date_range[]=<today>`,
    await get(`reports/${kind}?date_range[]=${from}&date_range[]=${to}`),
  );
}
// FluentCRM Pro (email sequences). A free-only site answers rest_no_route 404, which is recorded as is.
const sequences = await get("sequences?per_page=5&with[]=stats");
save("sequences.json", "GET sequences?per_page=5&with[]=stats", sequences);
const firstSequence = sequences.body.sequences?.data?.[0];
if (firstSequence) {
  save(
    "sequence-show.json",
    "GET sequences/<id>?with[]=sequence_emails&with[]=email_stats",
    await get(`sequences/${firstSequence.id}?with[]=sequence_emails&with[]=email_stats`),
  );
}
