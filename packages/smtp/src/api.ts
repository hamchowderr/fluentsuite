import {
  FluentSuiteError,
  isMissingRoute,
  LaravelPage,
  type NamespacedClient,
  type WordPressClient,
} from "@fluentsuite/core";
import * as z from "zod/v4";

/**
 * Typed access to FluentSMTP through the FluentSuite Bridge plugin (namespace `fluentsuite/v1`).
 *
 * FluentSMTP has no REST API of its own (its screens use admin-ajax with a cookie and nonce), so the bridge
 * in wordpress/fluentsuite-bridge exposes the same data. The bridge already strips secrets from connection
 * settings; secret masking of email content happens here, in mask.ts.
 */

const nullableString = z.string().nullish();

const Recipient = z.looseObject({ email: z.string(), name: nullableString });
export type Recipient = z.infer<typeof Recipient>;

export const LogRow = z.looseObject({
  id: z.coerce.number(),
  created_at: nullableString,
  status: z.string(),
  to: z.array(Recipient).default([]),
  from: nullableString,
  subject: nullableString,
  source: nullableString,
  provider: nullableString,
  retries: z.coerce.number().default(0),
  resent_count: z.coerce.number().default(0),
  error: nullableString,
});
export type LogRow = z.infer<typeof LogRow>;

const LogDetail = LogRow.extend({
  headers: z.array(z.looseObject({ name: z.string(), value: z.string() })).default([]),
  attachments: z.array(z.string()).default([]),
  response: nullableString,
  send_time_ms: z.coerce.number().nullish(),
  updated_at: nullableString,
  body: z.string().optional(),
  body_truncated: z.boolean().optional(),
});
export type LogDetail = z.infer<typeof LogDetail>;

const Counts = z.looseObject({ sent: z.coerce.number(), failed: z.coerce.number() });
export type Counts = z.infer<typeof Counts>;

const Connection = z.looseObject({
  id: z.string(),
  title: z.string(),
  provider: z.string(),
  sender_email: nullableString,
  sender_name: nullableString,
  senders: z.array(z.string()).default([]),
  is_default: z.boolean(),
  is_fallback: z.boolean(),
  host: nullableString,
  port: nullableString,
  encryption: nullableString,
});
export type Connection = z.infer<typeof Connection>;

const Status = z.looseObject({
  bridge: z.looseObject({ version: z.string(), sending_allowed: z.boolean() }),
  fluentsmtp: z.looseObject({ version: nullableString }),
  simulate: z.looseObject({ enabled: z.boolean(), by_constant: z.boolean() }),
  logging: z.looseObject({ enabled: z.boolean(), retention_days: z.coerce.number().nullish() }),
  connections: z.array(Connection),
  totals: Counts,
  last_7_days: Counts,
  last_failure: LogRow.nullable(),
});
export type Status = z.infer<typeof Status>;

const Report = z.looseObject({
  after: z.string(),
  before: z.string(),
  totals: Counts,
  days: z.array(z.looseObject({ date: z.string(), sent: z.number(), failed: z.number() })),
  sources: z.array(z.looseObject({ source: z.string(), sent: z.number(), failed: z.number() })),
  failure_reasons: z.array(
    z.looseObject({
      error: z.string(),
      count: z.number(),
      latest_id: z.coerce.number(),
      latest_at: nullableString,
    }),
  ),
});
export type Report = z.infer<typeof Report>;

const TestEmailResult = z.looseObject({
  sent: z.boolean(),
  error: nullableString,
  simulated: z.boolean(),
});
export type TestEmailResult = z.infer<typeof TestEmailResult>;

const ResendResult = z.looseObject({
  simulated: z.boolean(),
  results: z.array(
    z.looseObject({
      id: z.coerce.number(),
      status: z.enum(["sent", "failed", "skipped"]),
      error: nullableString,
    }),
  ),
});
export type ResendResult = z.infer<typeof ResendResult>;

const DeletePreview = z.looseObject({
  dry_run: z.literal(true),
  count: z.coerce.number(),
  sample: z.array(LogRow),
});
const DeleteDone = z.looseObject({ dry_run: z.literal(false), deleted: z.coerce.number() });

export interface DeleteCriteria {
  ids?: number[] | undefined;
  to?: string | undefined;
  older_than_days?: number | undefined;
  status?: "sent" | "failed" | undefined;
}

export interface LogFilter {
  status?: "sent" | "failed" | undefined;
  after?: string | undefined;
  before?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  source?: string | undefined;
  search?: string | undefined;
  ids?: number[] | undefined;
}

export class SmtpApi {
  private readonly bridge: NamespacedClient;

  constructor(readonly wp: WordPressClient) {
    this.bridge = wp.namespace("fluentsuite/v1");
  }

  /** Admin URL of FluentSMTP's email log, for linking from tool output. */
  logsUrl(): string {
    return `${this.wp.siteUrl.replace(/\/+$/, "")}/wp-admin/options-general.php?page=fluent-mail#/logs`;
  }

  status(signal?: AbortSignal): Promise<Status> {
    return this.call(() => this.bridge.get("smtp/status", { schema: Status, signal }));
  }

  logs(filter: LogFilter, page: { page: number; perPage: number }, signal?: AbortSignal) {
    return this.call(() =>
      this.bridge.get("smtp/logs", {
        query: { ...filter, page: page.page, per_page: page.perPage },
        schema: LaravelPage(LogRow),
        signal,
      }),
    );
  }

  async log(id: number, includeBody: boolean, signal?: AbortSignal): Promise<LogDetail> {
    try {
      return await this.call(() =>
        this.bridge.get(`smtp/logs/${id}`, {
          query: includeBody ? { include_body: true } : {},
          schema: LogDetail,
          signal,
        }),
      );
    } catch (error) {
      if (error instanceof FluentSuiteError && error.status === 404 && !isMissingRoute(error)) {
        throw new FluentSuiteError("not_found", `No logged email with id ${id}.`, {
          status: 404,
          hint: "Find ids with smtp_find_email_logs. Old logs may have been removed by FluentSMTP's log retention.",
        });
      }
      throw error;
    }
  }

  report(range: { after?: string | undefined; before?: string | undefined }, signal?: AbortSignal) {
    return this.call(() =>
      this.bridge.get("smtp/report", { query: range, schema: Report, signal }),
    );
  }

  /** Sends FluentSMTP's own test email. Sending route: the bridge refuses unless its wp-config lock is on. */
  testEmail(to: string, from: string | undefined, signal?: AbortSignal): Promise<TestEmailResult> {
    return this.call(() =>
      this.bridge.post("smtp/test-email", {
        body: { to, ...(from ? { from } : {}) },
        schema: TestEmailResult,
        signal,
      }),
    );
  }

  /** Resends failed emails to their original recipients. Sending route, as above. */
  resend(ids: number[], signal?: AbortSignal): Promise<ResendResult> {
    return this.call(() =>
      this.bridge.post("smtp/resend", { body: { ids }, schema: ResendResult, signal }),
    );
  }

  previewDelete(criteria: DeleteCriteria, signal?: AbortSignal) {
    return this.call(() =>
      this.bridge.post("smtp/logs/delete", {
        body: { ...criteria, dry_run: true },
        schema: DeletePreview,
        signal,
      }),
    );
  }

  deleteLogs(criteria: DeleteCriteria, expectedCount: number, signal?: AbortSignal) {
    return this.call(() =>
      this.bridge.post("smtp/logs/delete", {
        body: { ...criteria, dry_run: false, expected_count: expectedCount },
        schema: DeleteDone,
        signal,
      }),
    );
  }

  /** Turns "no route" into "install the bridge" and a 424 into "activate FluentSMTP". */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isMissingRoute(error)) {
        throw new FluentSuiteError(
          "not_found",
          "The FluentSuite Bridge plugin on this site is missing or older than this tool needs, and FluentSMTP has no REST API of its own.",
          {
            status: 404,
            hint: "Install or update the FluentSuite Bridge plugin (wordpress/fluentsuite-bridge in the FluentSuite repository) and activate it.",
          },
        );
      }
      if (
        error instanceof FluentSuiteError &&
        error.status === 403 &&
        /sending is turned off/i.test(error.message)
      ) {
        throw new FluentSuiteError("forbidden", error.message, {
          status: 403,
          hint: "The site owner has to allow sending in wp-config.php. Nothing was sent.",
        });
      }
      if (error instanceof FluentSuiteError && error.status === 424) {
        throw new FluentSuiteError("not_found", "FluentSMTP is not active on this site.", {
          status: 424,
          hint: "Activate FluentSMTP in wp-admin → Plugins.",
        });
      }
      if (error instanceof FluentSuiteError && error.code === "forbidden") {
        throw new FluentSuiteError(error.code, error.message, {
          status: error.status,
          hint: "The WordPress user needs FluentSMTP's manage permission (administrators by default).",
        });
      }
      throw error;
    }
  }
}
