import { unexpectedFixtureHosts } from "@fluentsuite/core/testing";
import { describe, expect, it } from "vitest";
import { createMockBridge, fixture, type LogEntry, rowOf } from "./mock-bridge.js";

/**
 * The offline mock must answer like the live bridge did. These compare what the mock computes from the recorded
 * email log with the responses recorded from the test site (scripts/record-smtp-fixtures.mjs). If the bridge's
 * PHP and the mock drift apart, re-record and these fail.
 */

const auth = `Basic ${Buffer.from("fluentsuite-test:testpasswordabcdefghijkl").toString("base64")}`;
async function get(route: string) {
  const site = createMockBridge();
  const res = await site.fetch(
    new Request(`${site.siteUrl}/wp-json/fluentsuite/v1/${route}`, {
      headers: { authorization: auth },
    }),
  );
  return { status: res.status, body: (await res.json()) as unknown };
}

describe("mock bridge matches the recorded bridge", () => {
  it("lists the log like GET smtp/logs?per_page=100", async () => {
    const recorded = fixture("logs-page.json");
    expect(await get("smtp/logs?per_page=100&page=1")).toEqual({
      status: recorded.status,
      body: recorded.body,
    });
  });

  it("builds the default report like GET smtp/report", async () => {
    const recorded = fixture("report.json");
    expect((await get("smtp/report")).body).toEqual(recorded.body);
  });

  it("builds a ranged report like GET smtp/report?after&before", async () => {
    const recorded = fixture("report-range.json");
    expect((await get("smtp/report?after=2026-10-05&before=2026-10-08")).body).toEqual(
      recorded.body,
    );
  });

  it("answers status like GET smtp/status", async () => {
    const recorded = fixture("status.json");
    expect((await get("smtp/status")).body).toEqual(recorded.body);
  });

  it("returns 404 for an unknown log like the bridge", async () => {
    const recorded = fixture("log-not-found.json");
    expect(await get("smtp/logs/999999")).toEqual({ status: recorded.status, body: recorded.body });
  });

  it("detail rows extend list rows", () => {
    const list = fixture<{ data: unknown[] }>("logs-page.json").body.data;
    const details = fixture<LogEntry[]>("logs-detail.json").body;
    expect(details.map(rowOf)).toEqual(list);
  });

  it("recordings contain only fictional recipients", () => {
    for (const e of fixture<LogEntry[]>("logs-detail.json").body) {
      for (const t of e.to) expect(t.email.endsWith("@example.com")).toBe(true);
    }
  });

  it("fixtures mention only example.test hosts and known third parties", () => {
    expect(unexpectedFixtureHosts(new URL("./fixtures/", import.meta.url))).toEqual([]);
  });
});
