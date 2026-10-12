import { describe, expect, it } from "vitest";
import { FluentSuiteError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import { WordPressClient } from "../src/wp/client.js";
import { toPhpQuery } from "../src/wp/query.js";

type Handler = (req: Request) => Response | Promise<Response>;

function client(
  handler: Handler,
  extra: Partial<ConstructorParameters<typeof WordPressClient>[0]> = {},
) {
  const calls: Request[] = [];
  const wp = new WordPressClient({
    siteUrl: "https://crm.example.test/",
    username: "admin",
    applicationPassword: "abcd efgh ijkl mnop qrst uvwx",
    sleep: async () => {},
    fetch: async (req) => {
      calls.push(req.clone());
      return handler(req);
    },
    ...extra,
  });
  return { wp, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

describe("toPhpQuery", () => {
  it("encodes arrays and nested objects with PHP brackets", () => {
    const q = toPhpQuery({
      search: "a b",
      tags: [1, 2],
      with: ["stats"],
      skip: undefined,
      flag: true,
      empty: null,
    });
    expect(q.toString()).toBe("search=a+b&tags%5B%5D=1&tags%5B%5D=2&with%5B%5D=stats&flag=1");
  });
});

describe("WordPressClient", () => {
  it("sends Basic auth with the Application Password (spaces removed) under /wp-json", async () => {
    const { wp, calls } = client(() => json({ ok: true }));
    await wp.namespace("fluent-crm/v2").get("subscribers", { query: { per_page: 5 } });
    const req = calls[0];
    expect(req?.url).toBe("https://crm.example.test/wp-json/fluent-crm/v2/subscribers?per_page=5");
    const expected = Buffer.from("admin:abcdefghijklmnopqrstuvwx").toString("base64");
    expect(req?.headers.get("authorization")).toBe(`Basic ${expected}`);
  });

  it("maps WordPress errors to typed errors with safe messages", async () => {
    const { wp } = client(() =>
      json(
        {
          code: "rest_forbidden",
          message: "Sorry, you are not allowed to do that.",
          data: { status: 403 },
        },
        403,
      ),
    );
    const error = await wp.request("GET", "fluent-crm/v2/subscribers").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FluentSuiteError);
    expect((error as FluentSuiteError).code).toBe("forbidden");
    expect((error as FluentSuiteError).message).toBe("Sorry, you are not allowed to do that.");
  });

  it("redacts emails in upstream error messages", async () => {
    const { wp } = client(() =>
      json({ message: "Contact jane.doe@example.com already exists" }, 422),
    );
    const error = (await wp
      .request("POST", "x", { body: {} })
      .catch((e: unknown) => e)) as FluentSuiteError;
    expect(error.code).toBe("invalid_input");
    expect(error.message).not.toContain("jane.doe@example.com");
    expect(error.message).toContain("j***@e***.com");
  });

  it("retries GET on 503 and honours Retry-After", async () => {
    let n = 0;
    const waits: number[] = [];
    const { wp, calls } = client(
      () =>
        ++n < 3 ? json({ message: "busy" }, 503, { "Retry-After": "1" }) : json({ fine: true }),
      { sleep: async (ms) => void waits.push(ms) },
    );
    const res = await wp.request<{ fine: boolean }>("GET", "x");
    expect(res.data.fine).toBe(true);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 1000]);
  });

  it("never retries writes", async () => {
    const { wp, calls } = client(() => json({ message: "busy" }, 503));
    await expect(wp.request("POST", "x", { body: { a: 1 } })).rejects.toMatchObject({
      code: "upstream_error",
    });
    expect(calls).toHaveLength(1);
  });

  it("reports network failures without leaking details", async () => {
    const { wp } = client(() => {
      throw new TypeError("getaddrinfo ENOTFOUND crm.example.test");
    });
    await expect(wp.request("GET", "x")).rejects.toMatchObject({
      code: "network_error",
      message: "Could not reach the WordPress site.",
    });
  });

  it("rejects non-JSON bodies with a helpful error", async () => {
    const { wp } = client(() => new Response("<br />Notice: Undefined index", { status: 200 }));
    await expect(wp.request("GET", "x")).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("times out slow requests", async () => {
    const { wp } = client(
      (req) =>
        new Promise((_, reject) => {
          req.signal.addEventListener("abort", () => reject(req.signal.reason));
        }),
      { timeoutMs: 1000, retries: 0 },
    );
    await expect(wp.request("GET", "x")).rejects.toMatchObject({ code: "timeout" });
  });

  it("logs the route shape only, never the query or credentials", async () => {
    const lines: string[] = [];
    const { wp } = client(() => json({}), {
      logger: createLogger("debug", (l) => void lines.push(l)),
    });
    await wp.request("GET", "fluent-crm/v2/subscribers/42", {
      query: { search: "jane@example.com" },
    });
    const log = lines.join("\n");
    expect(log).toContain("/wp-json/fluent-crm/v2/subscribers/:id");
    expect(log).not.toContain("jane");
    expect(log).not.toContain("Basic");
  });
});
