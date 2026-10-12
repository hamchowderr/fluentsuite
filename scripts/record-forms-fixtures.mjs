#!/usr/bin/env node
// Records Fluent Forms REST responses from the test site into packages/forms/test/fixtures/, scrubbed.
//
//   FLUENTSUITE_TEST_SITE_URL=https://<your test site> \
//   FLUENTSUITE_LIVE_SITE_URL=$FLUENTSUITE_TEST_SITE_URL \
//   FLUENTSUITE_LIVE_WP_USER=fluentsuite-mcp \
//   FLUENTSUITE_LIVE_APP_PASSWORD_FILE=/path/to/file \
//   node scripts/record-forms-fixtures.mjs
//
// Only GET requests, only against the FluentSuite test site, whose entries are fictional (@example.com). It never
// calls GET submissions/{id}: that route marks unread entries as read. The site URL becomes https://forms.example.test.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/forms/test/fixtures");
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
const api = `${site}/wp-json/fluentform/v1`;
const host = new URL(site).host;

async function get(route) {
  if (/^submissions\/\d+$/.test(route.split("?")[0])) throw new Error("never GET submissions/{id}");
  const res = await fetch(`${api}/${route}`, {
    headers: { Authorization: auth, Accept: "application/json" },
  });
  return { status: res.status, body: await res.json() };
}

function scrub(value) {
  if (typeof value === "string") {
    return value
      .split(site)
      .join("https://forms.example.test")
      .split(site.replace(/\//g, "\\/"))
      .join("https:\\/\\/forms.example.test")
      .split(host)
      .join("forms.example.test");
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  }
  return value;
}

function save(name, route, recorded) {
  writeFileSync(
    join(out, name),
    `${JSON.stringify({ route, status: recorded.status, body: scrub(recorded.body) }, null, 1)}\n`,
  );
  console.error(`recorded ${name} (HTTP ${recorded.status})`);
}

mkdirSync(out, { recursive: true });
const forms = await get("forms?per_page=50");
save("forms.json", "GET forms?per_page=50", forms);
const testForms = forms.body.data.filter((f) => / \(test\)$/.test(f.title));
const perForm = {};
const entries = [];
for (const f of testForms) {
  const id = f.id;
  perForm[id] = {
    form: (await get(`forms/${id}`)).body,
    resources: (await get(`submissions/resources?form_id=${id}&fields[]=labels`)).body,
    notifications: (await get(`settings/${id}?meta_key=notifications`)).body,
    integrations: (await get(`integrations/${id}/form-integrations`)).body,
  };
  for (const type of ["", "trashed"]) {
    const page = await get(
      `submissions?form_id=${id}&per_page=100${type ? `&entry_type=${type}` : ""}`,
    );
    for (const e of page.body.data) {
      const to = JSON.parse(e.response);
      for (const v of Object.values(to)) {
        if (typeof v === "string" && v.includes("@") && !v.endsWith("@example.com")) {
          console.error("Unexpected non-example.com address; refusing to record.");
          process.exit(1);
        }
      }
      entries.push(e);
    }
  }
}
save(
  "forms-detail.json",
  "GET forms/<id>, submissions/resources, settings notifications, integrations per test form",
  {
    status: 200,
    body: perForm,
  },
);
entries.sort((a, b) => a.id - b.id);
save(
  "entries.json",
  "GET submissions?form_id=<id>&per_page=100 (+ entry_type=trashed), every test form",
  {
    status: 200,
    body: entries,
  },
);
const noted = entries.filter((e) => e.serial_number === "2").map((e) => e.id);
const notes = {};
for (const id of noted) notes[id] = (await get(`submissions/${id}/notes`)).body;
save("notes.json", "GET submissions/<id>/notes for entries that have notes", {
  status: 200,
  body: notes,
});
const range = "start_date=2026-07-01&end_date=2026-10-12";
save(
  "report-overview.json",
  `GET report/overview-chart?${range}`,
  await get(`report/overview-chart?${range}`),
);
save(
  "report-form-stats.json",
  `GET report/form-stats?${range}`,
  await get(`report/form-stats?${range}`),
);
save(
  "report-top-forms.json",
  `GET report/top-performing-forms?${range}&metric=entries`,
  await get(`report/top-performing-forms?${range}&metric=entries`),
);
save(
  "report-revenue.json",
  `GET report/revenue-chart?${range}`,
  await get(`report/revenue-chart?${range}`),
);
