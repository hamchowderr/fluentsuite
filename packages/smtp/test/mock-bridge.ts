import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MockWordPress, mockJson } from "@fluentsuite/core/testing";

/**
 * A FluentSuite Bridge (FluentSMTP) site for offline tests, built from the scrubbed recordings of the test
 * site in fixtures/ (see scripts/record-smtp-fixtures.mjs). Searches, paging and reports are computed from
 * the recorded email log the same way the bridge's PHP does; recorded-contract tests check that the
 * computed answers match what the live bridge returned.
 */

const dir = join(import.meta.dirname, "fixtures");
export function fixture<T = unknown>(name: string): { route: string; status: number; body: T } {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

export interface LogEntry {
  id: number;
  created_at: string;
  status: string;
  to: Array<{ email: string; name: string | null }>;
  from: string | null;
  subject: string | null;
  source: string | null;
  provider: string | null;
  retries: number;
  resent_count: number;
  error: string | null;
  headers: Array<{ name: string; value: string }>;
  attachments: string[];
  response: string | null;
  send_time_ms: number | null;
  updated_at: string | null;
  body: string;
  body_truncated: boolean;
}

const ROW_KEYS = [
  "id",
  "created_at",
  "status",
  "to",
  "from",
  "subject",
  "source",
  "provider",
  "retries",
  "resent_count",
  "error",
] as const;

export function rowOf(e: LogEntry) {
  return Object.fromEntries(ROW_KEYS.map((k) => [k, e[k]]));
}

function byNewest(a: LogEntry, b: LogEntry) {
  return a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1;
}

function counts(rows: LogEntry[]) {
  const out = { sent: 0, failed: 0 };
  for (const r of rows) if (r.status === "sent" || r.status === "failed") out[r.status]++;
  return out;
}

export interface MockBridge {
  wp: MockWordPress;
  siteUrl: string;
  fetch: MockWordPress["fetch"];
  logs: LogEntry[];
  status: Record<string, unknown>;
  /** Every email the mock "sent" (test emails and resends), for assertions. Nothing leaves the test. */
  sent: Array<{ kind: "test" | "resend"; id?: number; to: string[] }>;
  /** Resends of these ids fail, like a provider that still refuses them. */
  failingIds: Set<number>;
}

export function createMockBridge(
  options: {
    bridge?: boolean;
    fluentsmtp?: boolean;
    siteUrl?: string;
    /** The site's FLUENTSUITE_BRIDGE_ALLOW_SENDING (the recording has it off). */
    bridgeSending?: boolean;
  } = {},
): MockBridge {
  const siteUrl = options.siteUrl ?? "https://smtp.example.test";
  const wp = new MockWordPress(siteUrl);
  const logs = fixture<LogEntry[]>("logs-detail.json").body.map((e) => ({ ...e }));
  const status = structuredClone(fixture<Record<string, unknown>>("status.json").body);
  (status.bridge as { sending_allowed: boolean }).sending_allowed = options.bridgeSending ?? false;
  const mock: MockBridge = {
    wp,
    siteUrl,
    fetch: wp.fetch,
    logs,
    status,
    sent: [],
    failingIds: new Set(),
  };
  if (options.bridge === false) return mock; // every fluentsuite/v1 route answers rest_no_route

  const inactive = () =>
    mockJson(
      {
        code: "fluentsuite_fluentsmtp_inactive",
        message: "FluentSMTP is not active on this site.",
        data: { status: 424 },
      },
      424,
    );

  wp.on("GET", "fluentsuite/v1/smtp/status", () => {
    if (options.fluentsmtp === false) return inactive();
    const sorted = [...logs].sort(byNewest);
    return mockJson({
      ...status,
      totals: counts(logs),
      last_failure: (() => {
        const f = sorted.find((r) => r.status === "failed");
        return f ? rowOf(f) : null;
      })(),
    });
  });

  wp.on("GET", "fluentsuite/v1/smtp/logs", ({ query }) => {
    if (options.fluentsmtp === false) return inactive();
    const q = (k: string) => query.get(k) ?? "";
    const like = (v: string | null | undefined, needle: string) =>
      (v ?? "").toLowerCase().includes(needle.toLowerCase());
    const toText = (e: LogEntry) => e.to.map((t) => `${t.name ?? ""} ${t.email}`).join(" ");
    const rows = logs
      .filter((e) => !q("status") || e.status === q("status"))
      .filter((e) => !q("after") || e.created_at >= `${q("after")} 00:00:00`)
      .filter((e) => !q("before") || e.created_at <= `${q("before")} 23:59:59`)
      .filter((e) => !q("to") || like(toText(e), q("to")))
      .filter((e) => !q("subject") || like(e.subject, q("subject")))
      .filter((e) => !q("source") || e.source === q("source"))
      .filter((e) => {
        const ids = query.getAll("ids[]").map(Number);
        return !ids.length || ids.includes(e.id);
      })
      .filter(
        (e) =>
          !q("search") ||
          like(toText(e), q("search")) ||
          like(e.from, q("search")) ||
          like(e.subject, q("search")),
      )
      .sort(byNewest);
    const perPage = Number(q("per_page") || 20);
    const page = Number(q("page") || 1);
    return mockJson({
      total: rows.length,
      per_page: perPage,
      current_page: page,
      last_page: Math.max(1, Math.ceil(rows.length / perPage)),
      data: rows.slice((page - 1) * perPage, page * perPage).map(rowOf),
    });
  });

  wp.on("GET", "fluentsuite/v1/smtp/logs/:id", ({ params, query }) => {
    if (options.fluentsmtp === false) return inactive();
    const e = logs.find((r) => r.id === Number(params.id));
    if (!e) {
      return mockJson(
        {
          code: "fluentsuite_not_found",
          message: "No logged email with that id.",
          data: { status: 404 },
        },
        404,
      );
    }
    const { body, body_truncated, ...rest } = e;
    const withBody = ["1", "true"].includes(query.get("include_body") ?? "");
    return mockJson(withBody ? { ...rest, body, body_truncated } : rest);
  });

  const sendingOff = () =>
    options.bridgeSending
      ? null
      : mockJson(
          {
            code: "fluentsuite_sending_disabled",
            message:
              "Sending is turned off in the FluentSuite Bridge on this site. To allow it, add define('FLUENTSUITE_BRIDGE_ALLOW_SENDING', true); to wp-config.php.",
            data: { status: 403 },
          },
          403,
        );
  const simulated = () => (status.simulate as { enabled: boolean }).enabled;

  wp.on("POST", "fluentsuite/v1/smtp/test-email", ({ body }) => {
    const off = sendingOff();
    if (off) return off;
    const { to, from } = body as { to: string; from?: string };
    const senders = (status.connections as Array<{ senders: string[] }>).flatMap((c) => c.senders);
    if (from && !senders.includes(from.toLowerCase())) {
      return mockJson(
        {
          code: "fluentsuite_unknown_sender",
          message: "That From address is not one of FluentSMTP's sender addresses.",
          data: { status: 400 },
        },
        400,
      );
    }
    mock.sent.push({ kind: "test", to: [to] });
    return mockJson({ sent: true, error: null, simulated: simulated() });
  });

  wp.on("POST", "fluentsuite/v1/smtp/resend", ({ body }) => {
    const off = sendingOff();
    if (off) return off;
    const ids = [...new Set((body as { ids: number[] }).ids)];
    const results = ids.map((id) => {
      const e = logs.find((r) => r.id === id);
      if (!e) return { id, status: "skipped", error: "No logged email with that id." };
      if (e.status !== "failed") {
        return { id, status: "skipped", error: `Not a failed email (status ${e.status}).` };
      }
      e.retries++;
      if (mock.failingIds.has(id)) return { id, status: "failed", error: e.error };
      // Only ever the original recipients.
      mock.sent.push({ kind: "resend", id, to: e.to.map((t) => t.email) });
      e.status = "sent";
      e.error = null;
      return { id, status: "sent", error: null };
    });
    return mockJson({ simulated: simulated(), results });
  });

  wp.on("POST", "fluentsuite/v1/smtp/logs/delete", ({ body }) => {
    const b = body as {
      ids?: number[];
      to?: string;
      older_than_days?: number;
      status?: string;
      dry_run?: boolean;
      expected_count?: number;
    };
    const given = [b.ids?.length ? 1 : 0, b.to ? 1 : 0, b.older_than_days ? 1 : 0];
    if (given.reduce((a, n) => a + n, 0) !== 1) {
      return mockJson(
        {
          code: "fluentsuite_invalid_criteria",
          message: 'Give exactly one of ids, to or older_than_days. There is no "delete all".',
          data: { status: 400 },
        },
        400,
      );
    }
    const cutoff = b.older_than_days
      ? new Date(
          Date.parse(`${fixture<{ before: string }>("report.json").body.before}T12:00:00Z`) -
            b.older_than_days * 86_400_000,
        )
          .toISOString()
          .replace("T", " ")
          .slice(0, 19)
      : "";
    const rows = logs
      .filter((e) => !b.ids?.length || b.ids.includes(e.id))
      .filter((e) => !b.to || e.to.some((t) => t.email.toLowerCase() === b.to?.toLowerCase()))
      .filter((e) => !cutoff || e.created_at < cutoff)
      .filter((e) => !b.status || e.status === b.status)
      .sort(byNewest);
    if (b.dry_run !== false) {
      return mockJson({ dry_run: true, count: rows.length, sample: rows.slice(0, 5).map(rowOf) });
    }
    if (b.expected_count === undefined) {
      return mockJson(
        {
          code: "fluentsuite_expected_count_required",
          message: "expected_count is required.",
          data: { status: 400 },
        },
        400,
      );
    }
    if (rows.length > b.expected_count) {
      return mockJson(
        {
          code: "fluentsuite_count_changed",
          message: `${rows.length} logs match now, more than the ${b.expected_count} previewed. Nothing was deleted.`,
          data: { status: 409 },
        },
        409,
      );
    }
    for (const r of rows) logs.splice(logs.indexOf(r), 1);
    return mockJson({ dry_run: false, deleted: rows.length });
  });

  wp.on("GET", "fluentsuite/v1/smtp/report", ({ query }) => {
    if (options.fluentsmtp === false) return inactive();
    const recorded = fixture<{ after: string; before: string }>("report.json").body;
    const before = query.get("before") || recorded.before;
    const after =
      query.get("after") ||
      new Date(Date.parse(`${before}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
    const inRange = logs.filter(
      (e) => e.created_at >= `${after} 00:00:00` && e.created_at <= `${before} 23:59:59`,
    );
    const days = new Map<string, { date: string; sent: number; failed: number }>();
    const sources = new Map<string, { source: string; sent: number; failed: number }>();
    for (const e of inRange) {
      const date = e.created_at.slice(0, 10);
      const d = days.get(date) ?? { date, sent: 0, failed: 0 };
      const name = e.source || "(unknown)";
      const s = sources.get(name) ?? { source: name, sent: 0, failed: 0 };
      if (e.status === "sent" || e.status === "failed") {
        d[e.status]++;
        s[e.status]++;
      }
      days.set(date, d);
      sources.set(name, s);
    }
    const reasons = new Map<
      string,
      { error: string; count: number; latest_id: number; latest_at: string }
    >();
    for (const e of inRange.filter((r) => r.status === "failed").sort(byNewest)) {
      const error = e.error ?? "(no error recorded)";
      const r = reasons.get(error) ?? { error, count: 0, latest_id: e.id, latest_at: e.created_at };
      r.count++;
      reasons.set(error, r);
    }
    return mockJson({
      after,
      before,
      totals: counts(inRange),
      days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
      sources: [...sources.values()]
        .sort(
          (a, b) =>
            b.sent + b.failed - (a.sent + a.failed) ||
            (a.source < b.source ? -1 : a.source > b.source ? 1 : 0),
        )
        .slice(0, 20),
      failure_reasons: [...reasons.values()]
        .sort((a, b) => b.count - a.count || b.latest_id - a.latest_id)
        .slice(0, 20),
    });
  });

  return mock;
}
