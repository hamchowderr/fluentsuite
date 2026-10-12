import { textOf } from "@fluentsuite/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { SMTP_ACTION_PREVIEW_URI } from "../src/index.js";
import { connectSmtp } from "./helpers.js";

/**
 * The SMTP write tools against the mock bridge (seeded with the recorded test-site log). Sending tools only
 * exist with writes AND allowSending on, refuse unless the site's bridge allows sending, always preview, and
 * need a token bound to exactly what was previewed. Nothing leaves the test: the mock records "sent" emails.
 */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
async function connect(options: Parameters<typeof connectSmtp>[0] = {}) {
  const c = await connectSmtp(options);
  close = c.close;
  return c;
}
const sending = { writes: true, allowSending: true, bridgeSending: true } as const;

type Out = Record<string, unknown> & {
  status?: string;
  confirmation_token?: string;
  count?: number;
};
const structured = (r: { structuredContent?: unknown }) => (r.structuredContent ?? {}) as Out;

describe("which SMTP tools are listed", () => {
  it("read-only: 4 read tools", async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools).toHaveLength(4);
  });

  it("writes on, sending off: adds only smtp_delete_email_logs", async () => {
    const { client } = await connect({ writes: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("smtp_delete_email_logs");
    expect(names).not.toContain("smtp_send_test_email");
    expect(names).not.toContain("smtp_resend_failed_emails");
  });

  it("writes and sending on: all 7, sending tools marked destructive-ish and with the preview view", async () => {
    const { client } = await connect(sending);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "smtp_delete_email_logs",
      "smtp_delivery_report",
      "smtp_email_detail",
      "smtp_find_email_logs",
      "smtp_resend_failed_emails",
      "smtp_send_test_email",
      "smtp_status",
    ]);
    const del = tools.find((t) => t.name === "smtp_delete_email_logs");
    expect(del?.annotations?.destructiveHint).toBe(true);
    for (const name of [
      "smtp_delete_email_logs",
      "smtp_send_test_email",
      "smtp_resend_failed_emails",
    ]) {
      const t = tools.find((x) => x.name === name);
      expect((t?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri).toBe(
        SMTP_ACTION_PREVIEW_URI,
      );
    }
  });
});

describe("smtp_send_test_email", () => {
  it("refuses, with the fix, when the site's bridge has sending off", async () => {
    const { call, site } = await connect({ ...sending, bridgeSending: false });
    const res = await call("smtp_send_test_email", { to: "qa@example.com" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/FLUENTSUITE_BRIDGE_ALLOW_SENDING/);
    expect(site.sent).toEqual([]);
  });

  it("previews, then sends only with the token", async () => {
    const { call, site } = await connect(sending);
    const preview = await call("smtp_send_test_email", { to: "qa@example.com" });
    const p = structured(preview);
    expect(p.status).toBe("preview");
    expect(p.simulate_mode).toBe(true);
    expect(textOf(preview)).toMatch(/Simulate mode is ON/);
    expect(site.sent).toEqual([]);

    const noToken = await call("smtp_send_test_email", { to: "qa@example.com", dry_run: false });
    expect(noToken.isError).toBe(true);
    expect(site.sent).toEqual([]);

    const otherAddress = await call("smtp_send_test_email", {
      to: "someone-else@example.com",
      dry_run: false,
      confirmation_token: p.confirmation_token,
    });
    expect(otherAddress.isError).toBe(true);
    expect(site.sent).toEqual([]);

    const done = await call("smtp_send_test_email", {
      to: "qa@example.com",
      dry_run: false,
      confirmation_token: p.confirmation_token,
    });
    expect(done.isError).toBeFalsy();
    expect(textOf(done)).toMatch(/simulated/);
    expect(site.sent).toEqual([{ kind: "test", to: ["qa@example.com"] }]);
  });

  it("only accepts FluentSMTP's own sender addresses", async () => {
    const { call } = await connect(sending);
    const res = await call("smtp_send_test_email", {
      to: "qa@example.com",
      from: "ceo@example.org",
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not one of FluentSMTP's sender addresses/);
  });
});

describe("smtp_resend_failed_emails", () => {
  it("resends only failed emails, only to their original recipients, after the token", async () => {
    const { call, site } = await connect(sending);
    const failed = site.logs
      .filter((l) => l.status === "failed")
      .slice(0, 2)
      .sort((a, b) => a.id - b.id);
    const ids = failed.map((l) => l.id);
    const preview = await call("smtp_resend_failed_emails", { ids });
    const p = structured(preview);
    expect(p.count).toBe(2);
    expect(p.confirmation_token).toBeTruthy();
    expect(site.sent).toEqual([]);

    const done = await call("smtp_resend_failed_emails", {
      ids,
      dry_run: false,
      confirmation_token: p.confirmation_token,
    });
    expect(done.isError).toBeFalsy();
    expect(site.sent).toEqual(
      failed.map((l) => ({ kind: "resend", id: l.id, to: l.to.map((t) => t.email) })),
    );
    expect(textOf(done)).toMatch(/2 sent, 0 failed/);
  });

  it("refuses ids that are not failed", async () => {
    const { call, site } = await connect(sending);
    const sent = site.logs.find((l) => l.status === "sent");
    const res = await call("smtp_resend_failed_emails", { ids: [sent?.id] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Only failed emails can be resent/);
  });

  it("has no way to send to someone else", async () => {
    const { client } = await connect(sending);
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "smtp_resend_failed_emails",
    );
    if (!tool) throw new Error("tool not listed");
    const props = Object.keys((tool.inputSchema as { properties: object }).properties);
    expect(props.sort()).toEqual(["after", "before", "confirmation_token", "dry_run", "ids"]);
  });

  it("binds the token to the exact emails previewed", async () => {
    const { call, site } = await connect(sending);
    const range = { after: "2026-09-01", before: "2026-10-12" };
    const preview = await call("smtp_resend_failed_emails", range);
    const p = structured(preview);
    // A new failure lands in the range after the preview.
    const template = site.logs.find((l) => l.status === "failed");
    if (!template) throw new Error("no failed log");
    site.logs.push({ ...template, id: 9001, created_at: "2026-10-12 08:00:00" });
    const res = await call("smtp_resend_failed_emails", {
      ...range,
      dry_run: false,
      confirmation_token: p.confirmation_token,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/does not match/);
    expect(site.sent).toEqual([]);
  });

  it("masks one-time codes in the preview and reports emails that fail again", async () => {
    const { call, site } = await connect(sending);
    const target = site.logs.find((l) => l.status === "failed");
    if (!target) throw new Error("no failed log");
    target.subject = "Your login code is 771203";
    site.failingIds.add(target.id);
    const preview = await call("smtp_resend_failed_emails", { ids: [target.id] });
    expect(JSON.stringify(preview)).not.toContain("771203");
    expect(textOf(preview)).toContain("[masked code]");
    const done = await call("smtp_resend_failed_emails", {
      ids: [target.id],
      dry_run: false,
      confirmation_token: structured(preview).confirmation_token,
    });
    expect(textOf(done)).toMatch(/0 sent, 1 failed/);
  });

  it("refuses ranges with more than 50 failures or none", async () => {
    const { call, site } = await connect(sending);
    const none = await call("smtp_resend_failed_emails", {
      after: "2020-01-01",
      before: "2020-01-31",
    });
    expect(textOf(none)).toMatch(/No failed emails/);
    const template = site.logs.find((l) => l.status === "failed");
    if (!template) throw new Error("no failed log");
    for (let i = 0; i < 50; i++) site.logs.push({ ...template, id: 8000 + i });
    const many = await call("smtp_resend_failed_emails", { after: "2026-01-01" });
    expect(many.isError).toBe(true);
    expect(textOf(many)).toMatch(/at most 50/);
  });
});

describe("smtp_delete_email_logs", () => {
  it("needs exactly one criterion: there is no delete-all", async () => {
    const { call } = await connect({ writes: true });
    expect((await call("smtp_delete_email_logs", {})).isError).toBe(true);
    expect((await call("smtp_delete_email_logs", { ids: [1], older_than_days: 3 })).isError).toBe(
      true,
    );
  });

  it("previews by recipient, then deletes exactly those with the token", async () => {
    const { call, site } = await connect({ writes: true });
    const email = "mia.rossi@example.com";
    const expected = site.logs.filter((l) => l.to.some((t) => t.email === email)).length;
    const preview = await call("smtp_delete_email_logs", { to: email });
    const p = structured(preview);
    expect(p.count).toBe(expected);
    expect(textOf(preview)).toMatch(/cannot be undone/);
    const before = site.logs.length;

    const noToken = await call("smtp_delete_email_logs", { to: email, dry_run: false });
    expect(noToken.isError).toBe(true);
    expect(site.logs).toHaveLength(before);

    const done = await call("smtp_delete_email_logs", {
      to: email,
      dry_run: false,
      confirmation_token: p.confirmation_token,
    });
    expect(done.isError).toBeFalsy();
    expect(site.logs).toHaveLength(before - expected);
    expect(site.logs.some((l) => l.to.some((t) => t.email === email))).toBe(false);
  });

  it("refuses when more logs match than were previewed", async () => {
    const { call, site } = await connect({ writes: true });
    const email = "mia.rossi@example.com";
    const preview = await call("smtp_delete_email_logs", { to: email });
    const template = site.logs.find((l) => l.to.some((t) => t.email === email));
    if (!template) throw new Error("no log");
    site.logs.push({ ...template, id: 9100 });
    const res = await call("smtp_delete_email_logs", {
      to: email,
      dry_run: false,
      confirmation_token: structured(preview).confirmation_token,
    });
    expect(res.isError).toBe(true);
    expect(site.logs.some((l) => l.id === 9100)).toBe(true);
  });

  it("says so when nothing matches, without a token", async () => {
    const { call } = await connect({ writes: true });
    const res = await call("smtp_delete_email_logs", { to: "nobody@example.com" });
    expect(textOf(res)).toMatch(/Nothing to delete/);
    expect(structured(res).confirmation_token).toBeUndefined();
  });
});

describe("SMTP view and skill", () => {
  it("serves the action-preview view and the troubleshooting skill", async () => {
    const { client } = await connect(sending);
    const view = await client.readResource({ uri: SMTP_ACTION_PREVIEW_URI });
    expect(view.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
    expect(String((view.contents[0] as { text?: string }).text)).toContain("<html");
    const list = await client.request(
      { method: "skills/list", params: {} },
      z.looseObject({
        skills: z.array(z.looseObject({ frontmatter: z.record(z.string(), z.unknown()) })),
      }),
    );
    expect(list.skills.map((s) => s.frontmatter.name)).toEqual(["smtp-delivery-troubleshooting"]);
  });

  it("the skill only names tools that exist", async () => {
    const { client } = await connect(sending);
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    const skill = await client.readResource({
      uri: "skill://smtp-delivery-troubleshooting/SKILL.md",
    });
    const used = JSON.stringify(skill).match(/smtp_[a-z_]+/g) ?? [];
    expect(used.length).toBeGreaterThan(4);
    for (const name of used) expect(names.has(name)).toBe(true);
  });
});
