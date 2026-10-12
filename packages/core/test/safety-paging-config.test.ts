import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/config.js";
import { decodeCursor, encodeCursor, pageInfo } from "../src/paging.js";
import { maskEmail, redact, redactValue } from "../src/redact.js";
import { guardedWrite, SafetyGuard } from "../src/safety.js";

const policy = {
  enabled: true,
  allowSending: false,
  bulkThreshold: 10,
  confirmSecret: "x".repeat(32),
  confirmTtlSeconds: 600,
};

describe("SafetyGuard", () => {
  it("binds tokens to the tool and exact arguments, ignoring control fields", () => {
    const guard = new SafetyGuard(policy);
    const args = { emails: ["a@x.test"], tag: "vip", dry_run: true };
    const { token } = guard.mint("crm_tag_contacts", args);
    expect(() =>
      guard.verify(
        "crm_tag_contacts",
        { ...args, dry_run: false, confirmation_token: token },
        token,
      ),
    ).not.toThrow();
    expect(() => guard.verify("crm_tag_contacts", { ...args, tag: "other" }, token)).toThrow(
      /does not match/,
    );
    expect(() => guard.verify("crm_other", args, token)).toThrow(/does not match/);
    expect(() => guard.verify("crm_tag_contacts", args, undefined)).toThrow(/needs confirmation/);
    expect(() => guard.verify("crm_tag_contacts", args, "garbage")).toThrow(/malformed/);
  });

  it("expires tokens", () => {
    let now = 1_000_000_000_000;
    const guard = new SafetyGuard(policy, () => now);
    const { token } = guard.mint("t", { a: 1 });
    now += 601_000;
    expect(() => guard.verify("t", { a: 1 }, token)).toThrow(/expired/);
  });

  it("needs confirmation for bulk, destructive and sending actions only", () => {
    const guard = new SafetyGuard(policy);
    expect(guard.needsConfirmation({ summary: "", affected: 10 })).toBe(false);
    expect(guard.needsConfirmation({ summary: "", affected: 11 })).toBe(true);
    expect(guard.needsConfirmation({ summary: "", affected: 1, destructive: true })).toBe(true);
    expect(guard.needsConfirmation({ summary: "", affected: 1, sendsEmail: true })).toBe(true);
  });

  it("guardedWrite previews without executing, then executes with a valid token", async () => {
    const guard = new SafetyGuard(policy);
    let executed = 0;
    const run = (
      args: Record<string, unknown> & { dry_run: boolean; confirmation_token?: string },
    ) =>
      guardedWrite({
        guard,
        tool: "t",
        args,
        plan: async () => ({ summary: "Tag 50 contacts", affected: 50 }),
        execute: async () => ++executed,
      });
    const preview = await run({ n: 50, dry_run: true });
    expect(preview.status).toBe("preview");
    expect(executed).toBe(0);
    if (preview.status !== "preview" || !preview.confirmation) throw new Error("expected token");
    await expect(run({ n: 50, dry_run: false })).rejects.toMatchObject({
      code: "confirmation_required",
    });
    const applied = await run({
      n: 50,
      dry_run: false,
      confirmation_token: preview.confirmation.token,
    });
    expect(applied.status).toBe("applied");
    expect(executed).toBe(1);
  });

  it("refuses writes when disabled", async () => {
    const guard = new SafetyGuard({ ...policy, enabled: false });
    await expect(
      guardedWrite({
        guard,
        tool: "t",
        args: { dry_run: true },
        plan: async () => ({ summary: "", affected: 1 }),
        execute: async () => 1,
      }),
    ).rejects.toMatchObject({ code: "writes_disabled" });
  });
});

describe("cursors", () => {
  it("round-trips and is bound to the tool and query", () => {
    const q = { search: "jane", tags: ["vip"] };
    const cursor = encodeCursor("crm_find_contacts", q, { page: 3, perPage: 25 });
    expect(
      decodeCursor("crm_find_contacts", { tags: ["vip"], search: "jane" }, cursor, 10),
    ).toEqual({ page: 3, perPage: 25 });
    expect(() => decodeCursor("crm_find_contacts", { search: "bob" }, cursor, 10)).toThrow(
      /different search/,
    );
    expect(() => decodeCursor("crm_other", q, cursor, 10)).toThrow(/not valid for this tool/);
    expect(() => decodeCursor("crm_find_contacts", q, "%%%", 10)).toThrow(/not valid/);
    expect(decodeCursor("crm_find_contacts", q, undefined, 10)).toEqual({ page: 1, perPage: 10 });
  });

  it("pageInfo only offers a cursor when more pages exist", () => {
    expect(
      pageInfo("t", {}, { total: 30, current_page: 1, per_page: 15, last_page: 2 }).nextCursor,
    ).toBeDefined();
    expect(
      pageInfo("t", {}, { total: 30, current_page: 2, per_page: 15, last_page: 2 }).nextCursor,
    ).toBeUndefined();
  });
});

describe("config", () => {
  const env = {
    FLUENTSUITE_SITE_URL: "https://crm.example.test",
    FLUENTSUITE_WP_USER: "admin",
    FLUENTSUITE_WP_APP_PASSWORD: "abcd efgh ijkl mnop qrst uvwx",
  };

  it("is read-only with CRM enabled by default", () => {
    const config = loadConfig({ env });
    expect(config.writes.enabled).toBe(false);
    expect(config.products).toEqual(["crm"]);
    expect(config.http.host).toBe("127.0.0.1");
  });

  it("keeps sending off unless explicitly allowed", () => {
    expect(loadConfig({ env: { ...env, FLUENTSUITE_WRITES: "true" } }).writes.allowSending).toBe(
      false,
    );
    expect(
      loadConfig({ env: { ...env, FLUENTSUITE_WRITES: "true", FLUENTSUITE_ALLOW_SENDING: "true" } })
        .writes.allowSending,
    ).toBe(true);
  });

  it("reads writes, products and http settings from env", () => {
    const config = loadConfig({
      env: {
        ...env,
        FLUENTSUITE_WRITES: "true",
        FLUENTSUITE_PRODUCTS: "crm, smtp",
        FLUENTSUITE_HTTP_PORT: "8080",
      },
    });
    expect(config.writes.enabled).toBe(true);
    expect(config.products).toEqual(["crm", "smtp"]);
    expect(config.http.port).toBe(8080);
  });

  it("rejects http:// sites unless explicitly allowed, without echoing secrets", () => {
    expect(() =>
      loadConfig({ env: { ...env, FLUENTSUITE_SITE_URL: "http://crm.example.test" } }),
    ).toThrow(/HTTPS/);
    expect(() =>
      parseConfig({ site: { url: "nope", username: "u", applicationPassword: "secret-value" } }),
    ).toThrow(/site\.url/);
    try {
      parseConfig({ site: { url: "nope", username: "u", applicationPassword: "secret-value" } });
    } catch (e) {
      expect(String(e)).not.toContain("secret-value");
    }
  });
});

describe("redaction", () => {
  it("masks emails, auth headers and application passwords", () => {
    expect(maskEmail("jane.doe@example.com")).toBe("j***@e***.com");
    expect(redact("Authorization: Basic YWRtaW46c2VjcmV0")).toBe("Authorization: Basic [redacted]");
    expect(redact("pw abcd efgh ijkl mnop qrst uvwx end")).toBe("pw [redacted] end");
    expect(redact("https://user:pass@site.test/x")).toBe("https://[redacted]@site.test/x");
    expect(redactValue({ email: "a@b.co", nested: { first_name: "Jane", count: 3 } })).toEqual({
      email: "[redacted]",
      nested: { first_name: "[redacted]", count: 3 },
    });
  });
});
