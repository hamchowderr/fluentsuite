#!/usr/bin/env node
// Records FluentSuite Bridge (FluentSMTP) responses from the test site into packages/smtp/test/fixtures/, scrubbed.
//
//   FLUENTSUITE_TEST_SITE_URL=https://<your test site> \
//   FLUENTSUITE_LIVE_SITE_URL=$FLUENTSUITE_TEST_SITE_URL \
//   FLUENTSUITE_LIVE_WP_USER=fluentsuite-mcp \
//   FLUENTSUITE_LIVE_APP_PASSWORD_FILE=/path/to/file \
//   node scripts/record-smtp-fixtures.mjs
//
// Only GET requests, only against the FluentSuite test site, whose email log is fictional (@example.com). The
// site URL is replaced with https://smtp.example.test, inside message bodies too.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/smtp/test/fixtures");
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
const api = `${site}/wp-json/fluentsuite/v1`;
const host = new URL(site).host;

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
      .join("https://smtp.example.test")
      .split(host)
      .join("smtp.example.test");
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  }
  return value;
}

function onlyExample(rows) {
  for (const r of rows) {
    for (const t of r.to ?? []) {
      if (!String(t.email).endsWith("@example.com")) {
        console.error("Unexpected non-example.com recipient; refusing to record.");
        process.exit(1);
      }
    }
  }
}

function save(name, route, recorded) {
  writeFileSync(
    join(out, name),
    `${JSON.stringify({ route, status: recorded.status, body: scrub(recorded.body) }, null, 1)}\n`,
  );
  console.error(`recorded ${name} (HTTP ${recorded.status})`);
}

mkdirSync(out, { recursive: true });
const status = await get("smtp/status");
save("status.json", "GET smtp/status", status);

// The whole fictional log with bodies, so offline tests can search and page it like the bridge does.
const all = await get("smtp/logs?per_page=100&page=1");
onlyExample(all.body.data);
save("logs-page.json", "GET smtp/logs?per_page=100&page=1", all);
const details = [];
for (const row of all.body.data) {
  details.push((await get(`smtp/logs/${row.id}?include_body=1`)).body);
}
save("logs-detail.json", "GET smtp/logs/<id>?include_body=1, for every row", {
  status: 200,
  body: details,
});
save("log-not-found.json", "GET smtp/logs/999999", await get("smtp/logs/999999"));
save("report.json", "GET smtp/report", await get("smtp/report"));
save(
  "report-range.json",
  "GET smtp/report?after=2026-10-05&before=2026-10-08",
  await get("smtp/report?after=2026-10-05&before=2026-10-08"),
);
