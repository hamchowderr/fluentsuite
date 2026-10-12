import { readFileSync } from "node:fs";
import { createServerFactory, parseConfig } from "@fluentsuite/core";
import { connectInProcess, textOf } from "@fluentsuite/core/testing";
import { crmProduct } from "@fluentsuite/crm";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { DELETE_CAP } from "../src/tools/delete-entries.js";
import { connectForms } from "./helpers.js";
import { type EntryRecord, fixture, forbiddenCalls } from "./mock-forms.js";

/**
 * The Fluent Forms write tools against the mock site (seeded with the recorded test-site entries). Every write
 * previews, bulk and destructive ones need a token bound to what was previewed, and no tool ever calls form-submit
 * or the auto-read entry route.
 */

const recorded = fixture<EntryRecord[]>("entries.json").body;
const forms =
  fixture<Record<string, { form: { id: number; title: string } }>>("forms-detail.json").body;
const formId = (title: string) =>
  Number(Object.values(forms).find((f) => f.form.title === title)?.form.id);
const CONTACT = formId("Contact (test)");
const NEWSLETTER = formId("Newsletter signup (test)");

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
async function connect(options: Parameters<typeof connectForms>[0] = { writes: true }) {
  const c = await connectForms(options);
  close = c.close;
  return c;
}
type Out = Record<string, unknown> & {
  status?: string;
  confirmation_token?: string;
  count?: number;
};
const out = (r: { structuredContent?: unknown }) => (r.structuredContent ?? {}) as Out;

describe("which Fluent Forms tools are listed", () => {
  it("read-only: 5; writes on: 8, with delete marked destructive", async () => {
    const ro = await connect({ writes: false });
    expect((await ro.client.listTools()).tools).toHaveLength(5);
    await close?.();
    close = undefined;
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "forms_add_entry_note",
      "forms_delete_entries",
      "forms_entry_detail",
      "forms_find_entries",
      "forms_form_summary",
      "forms_list",
      "forms_report",
      "forms_update_entries",
    ]);
    expect(tools.find((t) => t.name === "forms_delete_entries")?.annotations?.destructiveHint).toBe(
      true,
    );
    // No MCP Apps views for Forms (owner's decision).
    for (const t of tools) expect((t._meta as { ui?: unknown } | undefined)?.ui).toBeUndefined();
  });
});

describe("forms_update_entries", () => {
  it("marks a few entries read after a preview, skipping ones already read", async () => {
    const { call, site } = await connect();
    const contact = site.entries.filter((e) => e.form_id === String(CONTACT));
    const unread = contact.filter((e) => e.status === "unread").slice(0, 2);
    const read = contact.find((e) => e.status === "read");
    const ids = [...unread.map((e) => e.id), read?.id];
    const preview = await call("forms_update_entries", {
      form_id: CONTACT,
      action: "mark_read",
      ids,
    });
    expect(out(preview)).toMatchObject({ status: "preview", affected: 2, skipped: 1 });
    expect(out(preview).confirmation_token).toBeUndefined(); // 2 is not bulk
    expect(textOf(preview)).toMatch(/after_submission_status_update/);
    expect(unread.every((e) => e.status === "unread")).toBe(true);
    const done = await call("forms_update_entries", {
      form_id: CONTACT,
      action: "mark_read",
      ids,
      dry_run: false,
    });
    expect(done.isError).toBeFalsy();
    expect(site.entries.filter((e) => ids.includes(e.id)).every((e) => e.status === "read")).toBe(
      true,
    );
  });

  it("bulk changes need the token, bound to the exact entries", async () => {
    const { call, site } = await connect();
    const args = { form_id: CONTACT, action: "favorite", after: "2026-01-01" };
    const preview = await call("forms_update_entries", args);
    const p = out(preview);
    expect(Number(p.affected)).toBeGreaterThan(10);
    expect(p.confirmation_token).toBeTruthy();
    const noToken = await call("forms_update_entries", { ...args, dry_run: false });
    expect(noToken.isError).toBe(true);
    // A new entry lands in the range: the token no longer matches.
    const template = site.entries.find(
      (e) => e.form_id === String(CONTACT) && e.is_favourite === "0",
    );
    if (!template) throw new Error("no entry");
    site.entries.push({ ...template, id: 9001, created_at: "2026-10-12 09:00:00" });
    const stale = await call("forms_update_entries", {
      ...args,
      dry_run: false,
      confirmation_token: p.confirmation_token,
    });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toMatch(/does not match/);
  });

  it("names the hook in the preview: status changes fire one, favorites none", async () => {
    const { call, site } = await connect();
    const e = site.entries.find((x) => x.form_id === String(CONTACT) && x.status !== "trashed");
    if (!e) throw new Error("no entry");
    const trash = await call("forms_update_entries", {
      form_id: CONTACT,
      action: "trash",
      ids: [e.id],
    });
    expect(textOf(trash)).toMatch(/fluentform\/after_submission_status_update hook/);
    const fav = await call("forms_update_entries", {
      form_id: CONTACT,
      action: e.is_favourite === "1" ? "unfavorite" : "favorite",
      ids: [e.id],
    });
    expect(textOf(fav)).toMatch(/Fires no Fluent Forms hook/);
  });

  it("trash and restore", async () => {
    const { call, site } = await connect();
    const e = site.entries.find((x) => x.form_id === String(NEWSLETTER) && x.status === "read");
    if (!e) throw new Error("no entry");
    await call("forms_update_entries", {
      form_id: NEWSLETTER,
      action: "trash",
      ids: [e.id],
      dry_run: false,
    });
    expect(e.status).toBe("trashed");
    await call("forms_update_entries", {
      form_id: NEWSLETTER,
      action: "restore",
      ids: [e.id],
      dry_run: false,
    });
    expect(e.status).toBe("read");
  });

  it("refuses ids from another form, and ids mixed with a filter", async () => {
    const { call } = await connect();
    const other = recorded.find((e) => e.form_id === String(NEWSLETTER));
    const wrong = await call("forms_update_entries", {
      form_id: CONTACT,
      action: "mark_read",
      ids: [other?.id],
    });
    expect(wrong.isError).toBe(true);
    const mixed = await call("forms_update_entries", {
      form_id: CONTACT,
      action: "mark_read",
      ids: [1],
      status: "unread",
    });
    expect(mixed.isError).toBe(true);
  });
});

describe("forms_add_entry_note", () => {
  it("previews, then stores the note as plain text", async () => {
    const { call, site } = await connect();
    const e = site.entries.find((x) => x.form_id === String(CONTACT));
    if (!e) throw new Error("no entry");
    const preview = await call("forms_add_entry_note", {
      entry_id: e.id,
      note: "Call <b>back</b> Friday",
    });
    expect(textOf(preview)).toMatch(/Note: Call back Friday/);
    expect(textOf(preview)).toMatch(/fluentform\/submission_note_stored hook/);
    expect(site.notes[String(e.id)] ?? []).toHaveLength(0);
    await call("forms_add_entry_note", {
      entry_id: e.id,
      note: "Call <b>back</b> Friday",
      dry_run: false,
    });
    expect(site.notes[String(e.id)]?.at(-1)?.value).toBe("Call back Friday");
  });
});

describe("forms_delete_entries", () => {
  it("needs exactly one criterion, and form_id with ids: there is no delete-all", async () => {
    const { call } = await connect();
    expect((await call("forms_delete_entries", {})).isError).toBe(true);
    expect((await call("forms_delete_entries", { form_id: CONTACT })).isError).toBe(true);
    expect(
      (await call("forms_delete_entries", { ids: [1], email: "a@example.com", form_id: CONTACT }))
        .isError,
    ).toBe(true);
    expect((await call("forms_delete_entries", { ids: [1] })).isError).toBe(true);
  });

  it("deletes by exact email only after the token, and says files go too", async () => {
    const { call, site } = await connect();
    const target = site.entries.find(
      (e) => e.form_id === String(CONTACT) && JSON.parse(e.response).attachment,
    );
    if (!target) throw new Error("no entry");
    const email = JSON.parse(target.response).email as string;
    // A different address that contains the target as a substring must not be caught.
    site.entries.push({
      ...target,
      id: 9100,
      response: JSON.stringify({ ...JSON.parse(target.response), email: `x${email}` }),
    });
    const preview = await call("forms_delete_entries", { email });
    const p = out(preview);
    expect(p.count).toBe(1);
    expect(p.with_uploads).toBe(1);
    expect(textOf(preview)).toMatch(/cannot be undone/);
    expect(textOf(preview)).toMatch(/deletes those files too/);
    expect(textOf(preview)).toMatch(
      /fluentform\/before_deleting_entries and fluentform\/after_deleting_submissions hooks/,
    );
    const noToken = await call("forms_delete_entries", { email, dry_run: false });
    expect(noToken.isError).toBe(true);
    expect(site.entries.some((e) => e.id === target.id)).toBe(true);
    const done = await call("forms_delete_entries", {
      email,
      dry_run: false,
      confirmation_token: p.confirmation_token,
    });
    expect(done.isError).toBeFalsy();
    expect(site.entries.some((e) => e.id === target.id)).toBe(false);
    expect(site.entries.some((e) => e.id === 9100)).toBe(true);
  });

  it("refuses when more entries match than were previewed (token bound to the count)", async () => {
    const { call, site } = await connect();
    const preview = await call("forms_delete_entries", { trashed_older_than_days: 1 });
    const p = out(preview);
    expect(Number(p.count)).toBe(recorded.filter((e) => e.status === "trashed").length);
    const template = site.entries.find((e) => e.status === "trashed");
    if (!template) throw new Error("no trashed entry");
    site.entries.push({ ...template, id: 9200 });
    const res = await call("forms_delete_entries", {
      trashed_older_than_days: 1,
      dry_run: false,
      confirmation_token: p.confirmation_token,
    });
    expect(res.isError).toBe(true);
    expect(site.entries.filter((e) => e.status === "trashed").length).toBe(Number(p.count) + 1);
  });

  it(`is capped at ${DELETE_CAP} per call`, async () => {
    const { call, site } = await connect();
    const template = site.entries.find(
      (e) => e.form_id === String(CONTACT) && e.status === "trashed",
    );
    if (!template) throw new Error("no trashed entry");
    for (let i = 0; i < DELETE_CAP + 1; i++) site.entries.push({ ...template, id: 10_000 + i });
    const res = await call("forms_delete_entries", {
      form_id: CONTACT,
      trashed_older_than_days: 1,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(new RegExp(`at most ${DELETE_CAP}`));
  });

  it("says so when nothing matches, without a token", async () => {
    const { call } = await connect();
    const res = await call("forms_delete_entries", { email: "nobody@example.com" });
    expect(textOf(res)).toMatch(/Nothing to delete/);
    expect(out(res).confirmation_token).toBeUndefined();
  });
});

describe("no Fluent Forms tool touches form-submit or the auto-read entry route", () => {
  it("runs every tool, previews and applies, and checks the recorded requests", async () => {
    const { call, site } = await connect();
    const unread = site.entries.find((e) => e.form_id === String(CONTACT) && e.status === "unread");
    if (!unread) throw new Error("no unread entry");
    await call("forms_list");
    await call("forms_form_summary", { form_id: CONTACT });
    await call("forms_find_entries", {});
    await call("forms_entry_detail", { id: unread.id, include_notes: true });
    await call("forms_report");
    for (const dry of [true, false]) {
      await call("forms_update_entries", {
        form_id: CONTACT,
        action: "favorite",
        ids: [unread.id],
        dry_run: dry,
      });
      await call("forms_add_entry_note", { entry_id: unread.id, note: "Checked", dry_run: dry });
    }
    const del = await call("forms_delete_entries", {
      form_id: NEWSLETTER,
      trashed_older_than_days: 1,
    });
    await call("forms_delete_entries", {
      form_id: NEWSLETTER,
      trashed_older_than_days: 1,
      dry_run: false,
      confirmation_token: out(del).confirmation_token,
    });
    expect(forbiddenCalls(site)).toEqual([]);
    expect(site.wp.requests.some((r) => /form-submit/.test(r.route))).toBe(false);
    // Writes go only to the bulk and notes routes.
    const writes = site.wp.requests.filter((r) => r.method !== "GET").map((r) => r.route);
    expect(new Set(writes)).toEqual(
      new Set([
        "fluentform/v1/submissions/bulk-actions",
        `fluentform/v1/submissions/${unread.id}/notes`,
      ]),
    );
    expect(unread.status).toBe("unread"); // favoriting and noting don't mark it read
  });

  it("the production code never names the form-submit route", () => {
    for (const file of [
      "api.ts",
      "tools/update-entries.ts",
      "tools/add-note.ts",
      "tools/delete-entries.ts",
    ]) {
      const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(/form-submit/);
    }
  });
});

describe("forms-inbox-triage skill", () => {
  it("is served and only names tools that exist (forms_* here, crm_* in the CRM module)", async () => {
    const { client } = await connect();
    const list = await client.request(
      { method: "skills/list", params: {} },
      z.looseObject({
        skills: z.array(z.looseObject({ frontmatter: z.record(z.string(), z.unknown()) })),
      }),
    );
    expect(list.skills.map((s) => s.frontmatter.name)).toEqual(["forms-inbox-triage"]);
    const text = JSON.stringify(
      await client.readResource({ uri: "skill://forms-inbox-triage/SKILL.md" }),
    );
    const formsTools = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const name of text.match(/forms_[a-z_]+/g) ?? []) expect(formsTools.has(name)).toBe(true);

    const crm = await connectInProcess(
      createServerFactory({
        config: parseConfig({
          site: {
            url: "https://crm.example.test",
            username: "u",
            applicationPassword: "test pass word abcd efgh ijkl",
          },
          products: ["crm"],
          writes: { enabled: true },
          logLevel: "silent",
        }),
        products: [crmProduct],
      }),
    );
    try {
      const crmTools = new Set((await crm.client.listTools()).tools.map((t) => t.name));
      const used = text.match(/crm_[a-z_]+/g) ?? [];
      expect(used.length).toBeGreaterThan(2);
      for (const name of used) expect(crmTools.has(name)).toBe(true);
    } finally {
      await crm.close();
    }
  });
});
