import { readFileSync } from "node:fs";
import { createServerFactory, parseConfig } from "@fluentsuite/core";
import {
  connectInProcess,
  MockWordPress,
  mockJson,
  textOf,
  unexpectedFixtureHosts,
} from "@fluentsuite/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { crmProduct } from "../src/index.js";
import type { ContactProfile } from "../src/tools/contact-profile.js";

/**
 * Contract tests against responses RECORDED from the FluentSuite test site (FluentCRM 3.2.5, fictional data,
 * scrubbed by scripts/record-fixtures.mjs). If FluentCRM changes a response shape, re-record and these fail
 * offline, in CI, before any user sees it.
 */

interface Recording {
  route: string;
  status: number;
  body: unknown;
}
const recorded = (name: string): Recording =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/recorded/${name}`, import.meta.url), "utf8"),
  ) as Recording;
const reply = (r: Recording) => mockJson(r.body, r.status);

function server() {
  const wp = new MockWordPress();
  const ns = "fluent-crm/v2";
  wp.on("GET", `${ns}/subscribers/:id`, ({ query }) =>
    reply(
      recorded(
        query.get("get_by_email") === "nobody@example.com"
          ? "subscriber-not-found.json"
          : "subscriber-show-by-email.json",
      ),
    ),
  );
  wp.on("GET", `${ns}/subscribers/:id/emails`, () => reply(recorded("subscriber-emails.json")));
  wp.on("GET", `${ns}/subscribers/:id/notes`, () => reply(recorded("subscriber-notes.json")));
  const config = parseConfig({
    site: {
      url: wp.siteUrl,
      username: "fluentsuite-test",
      applicationPassword: "test pass word abcd efgh ijkl",
    },
    request: { retries: 0 },
    logLevel: "silent",
  });
  return createServerFactory({ config, products: [crmProduct], fetch: wp.fetch });
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("crm_contact_profile against recorded FluentCRM 3.2.5 responses", () => {
  it("parses a real contact, stats, custom fields and notes", async () => {
    const conn = await connectInProcess(server());
    close = conn.close;
    const result = await conn.client.callTool({
      name: "crm_contact_profile",
      arguments: { email: "yara.khan50@example.com" },
    });
    expect(result.isError).toBeFalsy();
    const p = result.structuredContent as ContactProfile;
    expect(p.contact).toMatchObject({
      id: 50,
      email: "yara.khan50@example.com",
      status: "subscribed",
    });
    expect(p.contact.tags).toEqual(["int:hosting", "src:webinar-2026-09", "stage:customer"]);
    expect(p.contact.custom_fields).toEqual({ plan: "Agency", company_size: "1-10" });
    expect(p.stats).toEqual({ emails: 0, opens: 0, clicks: 0 });
    expect(p.notes.map((n) => n.title)).toEqual(["Needs migration help"]);
    expect(textOf(result)).toContain("Yara Khan <yara.khan50@example.com> (contact #50)");
  });

  it("maps the real 422 'Subscriber not found' to not_found", async () => {
    const conn = await connectInProcess(server());
    close = conn.close;
    const result = await conn.client.callTool({
      name: "crm_contact_profile",
      arguments: { email: "nobody@example.com" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Error (not_found)");
  });
});

describe("recorded FluentCRM Pro sequence responses", () => {
  it("lists sequences in a paginator and shows emails with delays in seconds", () => {
    const list = recorded("sequences.json");
    expect(list.status).toBe(200);
    const page = (
      list.body as { sequences: { total: number; data: Array<{ type: string; status: string }> } }
    ).sequences;
    expect(page.total).toBeGreaterThan(0);
    expect(page.data[0]).toMatchObject({ type: "email_sequence", status: "draft" });

    const show = recorded("sequence-show.json").body as {
      sequence: { title: string };
      sequence_emails: Array<{ email_subject: string; delay: string }>;
    };
    expect(show.sequence.title).toBe("New lead nurture (test)");
    expect(show.sequence_emails.map((e) => [e.email_subject, Number(e.delay)])).toEqual([
      ["Welcome step 1", 2 * 86_400],
      ["Welcome step 2", 4 * 86_400],
    ]);
  });

  it("fixtures mention only example.test hosts and known third parties", () => {
    expect(unexpectedFixtureHosts(new URL("./fixtures/", import.meta.url))).toEqual([]);
  });
});
