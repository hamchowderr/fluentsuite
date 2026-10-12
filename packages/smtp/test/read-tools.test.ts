import { textOf } from "@fluentsuite/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { BODY_LIMIT } from "../src/tools/email-detail.js";
import { connectSmtp } from "./helpers.js";
import { fixture, type LogEntry } from "./mock-bridge.js";

/**
 * The SMTP read tools against the recorded test-site email log (FluentSMTP 2.4.1 through the FluentSuite
 * Bridge, fictional @example.com data). Expected numbers come from the same recording.
 */

const logs = fixture<LogEntry[]>("logs-detail.json").body;
const failed = logs.filter((l) => l.status === "failed");
const resetEmail = logs.find((l) => l.subject === "Password reset for your account");
const codeEmail = logs.find((l) => l.subject === "Your verification code");

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

type Structured<T> = { structuredContent?: T; isError?: boolean; content?: unknown };

describe("SMTP read tools", () => {
  it("lists exactly the 4 read tools, all read-only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "smtp_delivery_report",
      "smtp_email_detail",
      "smtp_find_email_logs",
      "smtp_status",
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("smtp_status: connections without secrets, counts, the latest failure and the simulate warning", async () => {
    const { call } = await connect();
    const res = (await call("smtp_status")) as Structured<{
      simulate_mode: boolean;
      connections: Array<Record<string, unknown>>;
      totals: { sent: number; failed: number };
      last_failure: { id: number; subject: string } | null;
      warnings: string[];
    }>;
    const s = res.structuredContent;
    expect(s?.simulate_mode).toBe(true);
    expect(s?.totals).toEqual({
      sent: logs.filter((l) => l.status === "sent").length,
      failed: failed.length,
    });
    expect(s?.connections[0]).toMatchObject({ provider: "smtp", host: "127.0.0.1", port: "1" });
    for (const c of s?.connections ?? []) {
      expect(Object.keys(c)).not.toEqual(
        expect.arrayContaining(["password", "username", "api_key", "access_token"]),
      );
    }
    expect(s?.warnings.join(" ")).toMatch(/Simulate mode is ON/);
    // The newest failure is the fake verification-code email: its subject has no code, but check masking runs.
    expect(s?.last_failure?.id).toBe(codeEmail?.id);
    expect(textOf(res)).toContain("Most recent failure");
  });

  it("smtp_find_email_logs: filters, newest first, pages with a cursor", async () => {
    const { call } = await connect();
    const first = (await call("smtp_find_email_logs", {
      status: "failed",
      per_page: 5,
    })) as Structured<{
      total: number;
      next_cursor?: string;
      emails: Array<{ id: number; status: string; created_at: string; error: string | null }>;
    }>;
    expect(first.structuredContent?.total).toBe(failed.length);
    const rows = first.structuredContent?.emails ?? [];
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.status === "failed" && r.error)).toBe(true);
    const dates = rows.map((r) => r.created_at);
    expect([...dates].sort().reverse()).toEqual(dates);

    const second = (await call("smtp_find_email_logs", {
      status: "failed",
      per_page: 5,
      cursor: first.structuredContent?.next_cursor,
    })) as Structured<{ emails: Array<{ id: number }> }>;
    const ids = new Set(rows.map((r) => r.id));
    expect(second.structuredContent?.emails.some((r) => ids.has(r.id))).toBe(false);

    // A cursor from one search can't be replayed against another.
    const wrong = await call("smtp_find_email_logs", {
      status: "sent",
      cursor: first.structuredContent?.next_cursor,
    });
    expect(wrong.isError).toBe(true);
  });

  it("smtp_find_email_logs: recipient, source and date filters", async () => {
    const { call } = await connect();
    const byTo = (await call("smtp_find_email_logs", { to: "mia.rossi" })) as Structured<{
      total: number;
      emails: Array<{ to: string[] }>;
    }>;
    expect(byTo.structuredContent?.total).toBe(
      logs.filter((l) => l.to.some((t) => t.email.includes("mia.rossi"))).length,
    );
    const bySource = (await call("smtp_find_email_logs", { source: "FluentCart" })) as Structured<{
      total: number;
    }>;
    expect(bySource.structuredContent?.total).toBe(
      logs.filter((l) => l.source === "FluentCart").length,
    );
    const bad = await call("smtp_find_email_logs", { after: "2026-10-10", before: "2026-10-01" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/later than/);
  });

  it("smtp_email_detail: no body unless asked; body as masked text", async () => {
    const { call, site } = await connect();
    const plain = (await call("smtp_email_detail", { id: resetEmail?.id })) as Structured<{
      body?: string;
      to: string[];
    }>;
    expect(plain.structuredContent?.body).toBeUndefined();
    expect(
      site.wp
        .calls("GET", `fluentsuite/v1/smtp/logs/${resetEmail?.id}`)[0]
        ?.query.get("include_body"),
    ).toBeNull();

    const full = (await call("smtp_email_detail", {
      id: resetEmail?.id,
      include_body: true,
    })) as Structured<{
      body: string;
    }>;
    const body = full.structuredContent?.body ?? "";
    expect(body).toContain("Reset your password (https://smtp.example.test/wp-login.php?[masked])");
    expect(body).not.toContain("FAKEkey");
    expect(textOf(full)).not.toContain("FAKEkey");
    expect(JSON.stringify(full)).not.toContain("action=rp");
  });

  it("smtp_email_detail: masks one-time codes in the body", async () => {
    const { call } = await connect();
    const res = (await call("smtp_email_detail", {
      id: codeEmail?.id,
      include_body: true,
    })) as Structured<{
      body: string;
    }>;
    expect(res.structuredContent?.body).toBe(
      "Your verification code is [masked code]. It expires in 10 minutes.",
    );
    expect(JSON.stringify(res)).not.toContain("482913");
  });

  it("smtp_email_detail: caps the body and masks subjects and headers", async () => {
    const { call, site } = await connect();
    const target = site.logs[0];
    if (!target) throw new Error("no logs");
    target.subject = "Your login code is 771203";
    target.body = `<p>${"word ".repeat(1000)}</p>`;
    target.headers = [
      { name: "List-Unsubscribe", value: "<https://smtp.example.test/?token=abc123>" },
    ];
    const res = (await call("smtp_email_detail", {
      id: target.id,
      include_body: true,
    })) as Structured<{
      subject: string;
      body: string;
      body_truncated: boolean;
      headers: Array<{ value: string }>;
    }>;
    expect(res.structuredContent?.subject).toBe("Your login code is [masked code]");
    expect(res.structuredContent?.body.length).toBeLessThanOrEqual(BODY_LIMIT + 1);
    expect(res.structuredContent?.body_truncated).toBe(true);
    expect(res.structuredContent?.headers[0]?.value).toBe("<https://smtp.example.test/?[masked]>");
  });

  it("smtp_email_detail: unknown id", async () => {
    const { call } = await connect();
    const res = await call("smtp_email_detail", { id: 999999 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/No logged email with id 999999/);
  });

  it("smtp_delivery_report: totals, failure reasons and sources", async () => {
    const { call } = await connect();
    const recorded = fixture<{ totals: { sent: number; failed: number } }>("report.json").body;
    const res = (await call("smtp_delivery_report")) as Structured<{
      totals: { sent: number; failed: number };
      failure_rate: number;
      failure_reasons: Array<{ error: string; count: number }>;
      sources: Array<{ source: string }>;
    }>;
    expect(res.structuredContent?.totals).toEqual(recorded.totals);
    const reasons = res.structuredContent?.failure_reasons ?? [];
    expect(reasons.reduce((n, r) => n + r.count, 0)).toBe(recorded.totals.failed);
    expect(res.structuredContent?.sources.map((s) => s.source)).toContain("FluentCRM");
    expect(textOf(res)).toMatch(/Failure reasons:/);
  });

  it("explains a missing bridge and an inactive FluentSMTP", async () => {
    const noBridge = await connect({ bridge: false });
    const a = await noBridge.call("smtp_status");
    expect(a.isError).toBe(true);
    expect(textOf(a)).toMatch(/FluentSuite Bridge plugin on this site is missing/);
    await close?.();
    close = undefined;

    const noSmtp = await connect({ fluentsmtp: false });
    const b = await noSmtp.call("smtp_find_email_logs");
    expect(b.isError).toBe(true);
    expect(textOf(b)).toMatch(/FluentSMTP is not active/);
  });
});
