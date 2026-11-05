import { createServerFactory, parseConfig } from "@fluentsuite/core";
import { connectInProcess, textOf } from "@fluentsuite/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { crmProduct } from "../src/index.js";
import { createRecordedSite, type RecordedSite } from "./mock-recorded-site.js";

/**
 * Write tools against a stateful mock seeded with the recorded test-site dataset. Every test checks
 * the safety rules: previews change nothing, bulk/destructive/sending actions need the token, and the
 * executed change matches the preview.
 */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function connect(
  writes: { enabled?: boolean; allowSending?: boolean } = { enabled: true },
  extra: Record<string, unknown> = {},
  options: { forbidTaxonomies?: boolean } = {},
) {
  const site = createRecordedSite();
  // A contacts-only WordPress user: FluentCRM answers 403 on the tag and list registries.
  const fetch: typeof site.fetch = options.forbidTaxonomies
    ? async (req) =>
        /\/fluent-crm\/v2\/(tags|lists)(\?|$)/.test(
          new URL(req.url).pathname + new URL(req.url).search,
        )
          ? new Response(
              JSON.stringify({
                code: "rest_forbidden",
                message: "Sorry, you are not allowed to do that.",
                data: { status: 403 },
              }),
              { status: 403, headers: { "Content-Type": "application/json" } },
            )
          : site.fetch(req)
    : site.fetch;
  const config = parseConfig({
    ...extra,
    site: {
      url: site.siteUrl,
      username: "fluentsuite-test",
      applicationPassword: "test pass word abcd efgh ijkl",
    },
    writes: {
      enabled: writes.enabled ?? true,
      allowSending: writes.allowSending ?? false,
      bulkThreshold: 10,
    },
    request: { retries: 0 },
    logLevel: "silent",
  });
  const conn = await connectInProcess(
    createServerFactory({ config, products: [crmProduct], fetch }),
  );
  close = conn.close;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await conn.client.callTool({ name, arguments: args });
    return { ...r, text: textOf(r), data: r.structuredContent as Record<string, unknown> };
  };
  return { client: conn.client, site, call };
}

const contact = (site: RecordedSite, email: string) =>
  site.state.contacts.find((c) => c.email === email);
const tagTitles = (site: RecordedSite, email: string) =>
  contact(site, email)?.tags.map((t) => t.title) ?? [];
const writes = (site: RecordedSite) => site.requests.filter((r) => r.method !== "GET");

describe("tool listing", () => {
  it("lists write tools only with writes on, and crm_send_campaign only with sending on too", async () => {
    const readOnly = await connect({ enabled: false });
    expect((await readOnly.client.listTools()).tools).toHaveLength(8);
    await close?.();
    const withWrites = await connect({ enabled: true });
    const names = (await withWrites.client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(14);
    expect(names).not.toContain("crm_send_campaign");
    await close?.();
    const withSending = await connect({ enabled: true, allowSending: true });
    const tools = (await withSending.client.listTools()).tools;
    const send = tools.find((t) => t.name === "crm_send_campaign");
    expect(send?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(withSending.client.getInstructions()).toContain("Email sending is ENABLED");
  });
});

describe("tool allowlist", () => {
  const AGENT_TOOLS = [
    "crm_add_contact_note",
    "crm_contact_profile",
    "crm_find_contacts",
    "crm_upsert_contact",
  ];

  it("serves exactly the listed tools", async () => {
    const { client } = await connect({ enabled: true }, { tools: AGENT_TOOLS });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(AGENT_TOOLS);
  });

  it("refuses a call to a tool that is not listed", async () => {
    const { site, call } = await connect({ enabled: true }, { tools: AGENT_TOOLS });
    await expect(
      call("crm_tag_contacts", {
        emails: ["yara.khan50@example.com"],
        add: ["stage:lead"],
        dry_run: false,
      }),
    ).rejects.toThrow(/crm_tag_contacts not found/);
    expect(writes(site)).toHaveLength(0);
  });

  it("still leaves listed write tools out while writes are off", async () => {
    const { client } = await connect({ enabled: false }, { tools: AGENT_TOOLS });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "crm_contact_profile",
      "crm_find_contacts",
    ]);
  });

  it("fails at boot on an unknown tool name", async () => {
    await expect(
      connect({ enabled: true }, { tools: ["crm_contact_profile", "crm_nope"] }),
    ).rejects.toThrow(/Unknown tools in tools \(FLUENTSUITE_TOOLS\): crm_nope/);
  });
});

describe("crm_tag_contacts", () => {
  const email = "yara.khan50@example.com";

  it("previews by default and changes nothing", async () => {
    const { site, call } = await connect();
    const before = tagTitles(site, email);
    const r = await call("crm_tag_contacts", { emails: [email], add: ["VIP"] });
    expect(r.text).toContain("DRY RUN");
    expect(r.data.status).toBe("preview");
    expect(tagTitles(site, email)).toEqual(before);
    expect(writes(site)).toHaveLength(0);
  });

  it("applies a small change without a token, and skips contacts already up to date", async () => {
    const { site, call } = await connect();
    const r = await call("crm_tag_contacts", {
      emails: [email, "nobody@example.com"],
      add: ["VIP"],
      remove: ["int:hosting"],
      dry_run: false,
    });
    expect(r.data).toMatchObject({
      status: "applied",
      affected: 1,
      unknown_emails: ["nobody@example.com"],
    });
    expect(tagTitles(site, email)).toContain("VIP");
    expect(tagTitles(site, email)).not.toContain("int:hosting");
    const again = await call("crm_tag_contacts", { emails: [email], add: ["VIP"], dry_run: false });
    expect(again.data.affected).toBe(0);
  });

  it("needs the confirmation token for bulk changes, bound to the exact arguments", async () => {
    const { site, call } = await connect();
    const args = {
      segment: { lists_any: ["Newsletter"], statuses: ["subscribed"] },
      add: ["tmp:winback-2026-q4"],
    };
    const preview = await call("crm_tag_contacts", args);
    const token = preview.data.confirmation_token as string;
    expect(preview.data.affected).toBeGreaterThan(10);
    expect(token).toBeTruthy();

    const refused = await call("crm_tag_contacts", { ...args, dry_run: false });
    expect(refused.text).toContain("confirmation_required");
    const tampered = await call("crm_tag_contacts", {
      ...args,
      add: ["VIP"],
      dry_run: false,
      confirmation_token: token,
    });
    expect(tampered.text).toContain("does not match these arguments");
    expect(writes(site)).toHaveLength(0);

    const applied = await call("crm_tag_contacts", {
      ...args,
      dry_run: false,
      confirmation_token: token,
    });
    expect(applied.data.status).toBe("applied");
    const tagged = site.state.contacts.filter((c) =>
      c.tags.some((t) => t.title === "tmp:winback-2026-q4"),
    );
    expect(tagged).toHaveLength(preview.data.affected as number);
  });

  it("refuses unknown tags unless create_missing, then creates them", async () => {
    const { site, call } = await connect();
    const unknown = await call("crm_tag_contacts", { emails: [email], add: ["brand-new"] });
    expect(unknown.text).toContain("Unknown tag: brand-new");
    const created = await call("crm_tag_contacts", {
      emails: [email],
      add: ["brand-new"],
      create_missing: true,
      dry_run: false,
    });
    expect(created.data.created).toEqual(["brand-new"]);
    expect(tagTitles(site, email)).toContain("brand-new");
  });

  it("requires exactly one of emails or segment", async () => {
    const { call } = await connect();
    const both = await call("crm_tag_contacts", {
      emails: [email],
      segment: { tags_any: ["VIP"] },
      add: ["VIP"],
    });
    expect(both.isError).toBe(true);
  });
});

describe("crm_update_list_membership", () => {
  it("never adds unsubscribed or bounced contacts to lists", async () => {
    const { site, call } = await connect();
    const blocked = site.state.contacts.find(
      (c) => c.status === "unsubscribed" || c.status === "bounced",
    );
    const ok = site.state.contacts.find(
      (c) => c.status === "subscribed" && !c.lists.some((l) => l.title === "Webinar attendees"),
    );
    if (!blocked || !ok) throw new Error("dataset changed");
    const r = await call("crm_update_list_membership", {
      emails: [blocked.email, ok.email],
      add: ["Webinar attendees"],
      dry_run: false,
    });
    expect(r.data.affected).toBe(1);
    expect((r.data.skipped as Array<{ email: string }>).map((s) => s.email)).toEqual([
      blocked.email,
    ]);
    expect(contact(site, blocked.email)?.lists.some((l) => l.title === "Webinar attendees")).toBe(
      false,
    );
    expect(contact(site, ok.email)?.lists.some((l) => l.title === "Webinar attendees")).toBe(true);
  });
});

describe("crm_set_contact_status", () => {
  it("always needs confirmation to unsubscribe, even one contact", async () => {
    const { site, call } = await connect();
    const target = site.state.contacts.find((c) => c.status === "subscribed");
    const args = { emails: [target?.email], status: "unsubscribed" };
    const preview = await call("crm_set_contact_status", args);
    expect(preview.data.confirmation_token).toBeTruthy();
    expect((await call("crm_set_contact_status", { ...args, dry_run: false })).text).toContain(
      "confirmation_required",
    );
    await call("crm_set_contact_status", {
      ...args,
      dry_run: false,
      confirmation_token: preview.data.confirmation_token,
    });
    expect(contact(site, target?.email ?? "")?.status).toBe("unsubscribed");
  });

  it("never re-subscribes contacts who unsubscribed or bounced", async () => {
    const { site, call } = await connect();
    const gone = site.state.contacts.find((c) => c.status === "bounced");
    const r = await call("crm_set_contact_status", {
      emails: [gone?.email],
      status: "subscribed",
      dry_run: false,
    });
    expect(r.data.affected).toBe(0);
    expect(contact(site, gone?.email ?? "")?.status).toBe("bounced");
  });
});

describe("crm_upsert_contact", () => {
  it("creates a new contact without a double opt-in email", async () => {
    const { site, call } = await connect();
    const r = await call("crm_upsert_contact", {
      email: "new.lead@example.com",
      first_name: "New",
      tags: ["stage:lead"],
      lists: ["Newsletter"],
      custom_fields: { plan: "Free" },
      dry_run: false,
    });
    expect(r.data).toMatchObject({ status: "applied", action: "create" });
    const created = contact(site, "new.lead@example.com");
    expect(created).toMatchObject({
      status: "subscribed",
      double_optin_sent: false,
      custom_values: { plan: "Free" },
    });
    expect(created?.tags.map((t) => t.title)).toEqual(["stage:lead"]);
  });

  it("previews a field diff for an existing contact and merges custom fields", async () => {
    const { site, call } = await connect();
    const email = "yara.khan50@example.com";
    const preview = await call("crm_upsert_contact", {
      email,
      last_name: "Khan-Smith",
      custom_fields: { plan: "Pro" },
    });
    expect(preview.text).toContain("last_name: Khan → Khan-Smith");
    await call("crm_upsert_contact", {
      email,
      last_name: "Khan-Smith",
      custom_fields: { plan: "Pro" },
      dry_run: false,
    });
    expect(contact(site, email)).toMatchObject({ last_name: "Khan-Smith" });
    expect(contact(site, email)?.custom_values).toMatchObject({ plan: "Pro" });
    const status = await call("crm_upsert_contact", { email, status: "pending" });
    expect(status.text).toContain("status only applies to new contacts");
  });
});

describe("crm_upsert_contact if_exists", () => {
  const existing = "yara.khan50@example.com";

  it("error refuses an existing contact in preview and apply, writing nothing", async () => {
    const { site, call } = await connect();
    for (const dry_run of [true, false]) {
      const r = await call("crm_upsert_contact", {
        email: existing,
        last_name: "Changed",
        if_exists: "error",
        dry_run,
      });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Error (already_exists)");
    }
    expect(writes(site)).toHaveLength(0);
    expect(contact(site, existing)?.last_name).toBe("Khan");
  });

  it("skip leaves an existing contact unchanged and says so", async () => {
    const { site, call } = await connect();
    const r = await call("crm_upsert_contact", {
      email: existing,
      last_name: "Changed",
      if_exists: "skip",
      dry_run: false,
    });
    expect(r.data).toMatchObject({ action: "none", changes: [] });
    expect(r.text).toContain("skipped");
    expect(writes(site)).toHaveLength(0);
  });

  it("creates a new contact under every value", async () => {
    const { site, call } = await connect();
    for (const if_exists of ["update", "skip", "error"]) {
      const email = `new.${if_exists}@example.com`;
      const r = await call("crm_upsert_contact", { email, if_exists, dry_run: false });
      expect(r.data).toMatchObject({ status: "applied", action: "create" });
      expect(contact(site, email)).toBeDefined();
    }
  });
});

describe("crm_upsert_contact with tags and lists off", () => {
  const off = { crm: { upsertTagsLists: false } };

  it("has no tags or lists in its input", async () => {
    const { client } = await connect({ enabled: true }, off);
    const upsert = (await client.listTools()).tools.find((t) => t.name === "crm_upsert_contact");
    const props = Object.keys(upsert?.inputSchema.properties ?? {});
    expect(props).toContain("email");
    expect(props).not.toContain("tags");
    expect(props).not.toContain("lists");
  });

  it("refuses a call that sends tags or lists, writing nothing", async () => {
    const { site, call } = await connect({ enabled: true }, off);
    for (const extra of [{ tags: ["stage:lead"] }, { lists: ["Newsletter"] }]) {
      const attempt = call("crm_upsert_contact", {
        email: "tagged.lead@example.com",
        ...extra,
        dry_run: false,
      }).then((r) => r.isError);
      // The SDK rejects input outside the schema, as a protocol error or an error result.
      await expect(attempt.catch(() => true)).resolves.toBe(true);
    }
    expect(writes(site)).toHaveLength(0);
  });

  it("still creates a contact without them", async () => {
    const { site, call } = await connect({ enabled: true }, off);
    const r = await call("crm_upsert_contact", {
      email: "plain.lead@example.com",
      first_name: "Plain",
      dry_run: false,
    });
    expect(r.data).toMatchObject({ status: "applied", action: "create" });
    expect(contact(site, "plain.lead@example.com")?.tags).toEqual([]);
  });
});

describe("contacts-only WordPress user", () => {
  const taxonomyReads = (site: RecordedSite) =>
    site.requests.filter(
      (r) => r.method === "GET" && /^fluent-crm\/v2\/(tags|lists)$/.test(r.route),
    );

  it("searches by text without reading tags or lists", async () => {
    const { site, call } = await connect({ enabled: true }, {}, { forbidTaxonomies: true });
    const r = await call("crm_find_contacts", { search: "example", per_page: 2 });
    expect(r.isError).toBeFalsy();
    expect(r.data).toMatchObject({ total: 50 });
    expect(taxonomyReads(site)).toHaveLength(0);
  });

  it("adds a contact without reading tags or lists", async () => {
    const { site, call } = await connect({ enabled: true }, {}, { forbidTaxonomies: true });
    const r = await call("crm_upsert_contact", {
      email: "least.privilege@example.com",
      first_name: "Least",
      if_exists: "error",
      dry_run: false,
    });
    expect(r.data).toMatchObject({ status: "applied", action: "create" });
    expect(taxonomyReads(site)).toHaveLength(0);
  });

  it("still loads the registry and rejects unknown names when a tag is named", async () => {
    const { site, call } = await connect();
    const r = await call("crm_find_contacts", { tags_any: ["no-such-tag"] });
    expect(r.text).toContain("Unknown tag");
    expect(taxonomyReads(site).length).toBeGreaterThan(0);
  });
});

describe("crm_add_contact_note", () => {
  it("logs a note as escaped HTML paragraphs", async () => {
    const { site, call } = await connect();
    await call("crm_add_contact_note", {
      email: "yara.khan50@example.com",
      title: "Call recap",
      description: "Wants <b>3</b> sites.\n\nFollow up Friday.",
      type: "call",
      dry_run: false,
    });
    expect(site.state.notes[0]).toMatchObject({
      title: "Call recap",
      type: "call",
      description: "<p>Wants &lt;b&gt;3&lt;/b&gt; sites.</p><p>Follow up Friday.</p>",
    });
  });
});

describe("crm_draft_campaign and crm_send_campaign", () => {
  const draft = {
    title: "Win-back (test)",
    subject: "We miss you",
    body: "Hi {{contact.first_name}},\n\nCome back.",
    audience: { lists_any: ["Newsletter"], exclude_tags: ["stage:customer"] },
  };

  it("drafts a campaign whose preview count matches its recipients, and never sends", async () => {
    const { site, call } = await connect();
    const preview = await call("crm_draft_campaign", draft);
    const created = await call("crm_draft_campaign", { ...draft, dry_run: false });
    expect(created.data.estimated_recipients).toBe(preview.data.estimated_recipients);
    const campaign = site.state.campaigns.get(created.data.campaign_id as number);
    expect(campaign).toMatchObject({ status: "draft", email_subject: "We miss you" });
    expect(String(campaign?.email_body)).toContain("<p>Come back.</p>");
    expect(site.state.sent).toHaveLength(0);
    expect(site.requests.some((r) => /\/(schedule|subscribe)$/.test(r.route))).toBe(false);
  });

  it("sends only with the token and the previewed recipient count", async () => {
    const { site, call } = await connect({ enabled: true, allowSending: true });
    const id = (await call("crm_draft_campaign", { ...draft, dry_run: false })).data
      .campaign_id as number;
    const preview = await call("crm_send_campaign", { campaign_id: id });
    const recipients = preview.data.recipients as number;
    const token = preview.data.confirmation_token as string;
    expect(preview.text).toContain(`expected_recipients=${recipients}`);
    expect(preview.data.sample).toHaveLength(5);

    expect(
      (
        await call("crm_send_campaign", {
          campaign_id: id,
          dry_run: false,
          expected_recipients: recipients,
        })
      ).text,
    ).toContain("confirmation_required");
    expect(
      (
        await call("crm_send_campaign", {
          campaign_id: id,
          dry_run: false,
          expected_recipients: recipients + 5,
          confirmation_token: token,
        })
      ).text,
    ).toContain("does not match");
    expect(site.state.sent).toHaveLength(0);

    const sent = await call("crm_send_campaign", {
      campaign_id: id,
      dry_run: false,
      expected_recipients: recipients,
      confirmation_token: token,
    });
    expect(sent.data).toMatchObject({ status: "applied", campaign_status: "processing" });
    expect(site.state.sent).toEqual([{ campaign_id: id, scheduled_at: "", recipients }]);

    const again = await call("crm_send_campaign", { campaign_id: id });
    expect(again.text).toContain("not a draft");
  });

  it("refuses to send when the audience grew after the preview", async () => {
    const { site, call } = await connect({ enabled: true, allowSending: true });
    const id = (await call("crm_draft_campaign", { ...draft, dry_run: false })).data
      .campaign_id as number;
    const preview = await call("crm_send_campaign", {
      campaign_id: id,
      schedule_at: "2026-10-20 09:00",
    });
    // Someone joins the Newsletter after the user approved the preview.
    const newsletter = site.state.lists.find((l) => l.title === "Newsletter");
    site.state.contacts.push({
      id: 9999,
      email: "late.joiner@example.com",
      first_name: "Late",
      last_name: "Joiner",
      status: "subscribed",
      created_at: "2026-10-12 03:00:00",
      tags: [],
      lists: newsletter ? [newsletter] : [],
    });
    const r = await call("crm_send_campaign", {
      campaign_id: id,
      schedule_at: "2026-10-20 09:00",
      dry_run: false,
      expected_recipients: preview.data.recipients,
      confirmation_token: preview.data.confirmation_token,
    });
    expect(r.text).toContain("audience grew");
    expect(site.state.sent).toHaveLength(0);
  });
});
