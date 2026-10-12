import type * as z from "zod/v4";
import { codeForStatus, FluentSuiteError } from "../errors.js";
import { type Logger, silentLogger } from "../logger.js";
import { redact } from "../redact.js";
import { type Query, toPhpQuery } from "./query.js";

export type FetchLike = (input: Request) => Promise<Response>;

export interface WordPressClientOptions {
  /** Site root, e.g. https://example.com */
  siteUrl: string;
  username: string;
  applicationPassword: string;
  timeoutMs?: number;
  /** Retries for GET requests only. */
  retries?: number;
  /** Injected for tests; defaults to global fetch. */
  fetch?: FetchLike;
  logger?: Logger;
  userAgent?: string;
  /** Overridable for tests so retries do not slow the suite down. */
  sleep?: (ms: number) => Promise<void>;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions<T> {
  query?: Query;
  body?: unknown;
  /** Optional zod schema; the response is validated and typed with it. */
  schema?: z.ZodType<T>;
  /** Cancellation from the MCP request. */
  signal?: AbortSignal;
}

export interface WpResponse<T> {
  data: T;
  status: number;
  /** X-WP-Total / X-WP-TotalPages when WordPress sends them. */
  total: number | undefined;
  totalPages: number | undefined;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 10_000;

function joinUrl(siteUrl: string, path: string): URL {
  const root = siteUrl.replace(/\/+$/, "");
  const clean = path.replace(/^\/+/, "");
  return new URL(`${root}/wp-json/${clean}`);
}

function headerInt(res: Response, name: string): number | undefined {
  const raw = res.headers.get(name);
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Pull a safe, short message out of a WordPress REST error body. */
function wpErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "message" in body) {
    const message = (body as { message: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return redact(message.replace(/<[^>]+>/g, "").trim()).slice(0, 300);
    }
  }
  return `WordPress returned HTTP ${status}.`;
}

/**
 * Minimal WordPress REST client with Application Password (HTTP Basic) auth.
 *
 * - Timeouts on every request, merged with MCP cancellation.
 * - Retries with backoff for GET only (writes are never retried, to avoid double effects).
 * - Errors are mapped to {@link FluentSuiteError} with redacted, size-capped messages.
 * - Nothing about the request (URL query, body, credentials) is logged.
 */
export class WordPressClient {
  readonly siteUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly userAgent: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: WordPressClientOptions) {
    this.siteUrl = options.siteUrl;
    this.authHeader = `Basic ${Buffer.from(
      `${options.username}:${options.applicationPassword.replace(/\s+/g, "")}`,
    ).toString("base64")}`;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retries = options.retries ?? 2;
    this.fetchImpl = options.fetch ?? ((req) => fetch(req));
    this.logger = options.logger ?? silentLogger;
    this.userAgent = options.userAgent ?? "FluentSuite";
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** A client scoped to one REST namespace, e.g. `fluent-crm/v2`. */
  namespace(ns: string): NamespacedClient {
    return new NamespacedClient(this, ns);
  }

  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    options: RequestOptions<T> = {},
  ): Promise<WpResponse<T>> {
    const url = joinUrl(this.siteUrl, path);
    const params = toPhpQuery(options.query);
    params.forEach((value, key) => {
      url.searchParams.append(key, value);
    });

    const attempts = method === "GET" ? this.retries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.send(method, url, options);
        if (res.ok) return await this.parse(res, options.schema);
        const body: unknown = await res.json().catch(() => undefined);
        const error = new FluentSuiteError(
          codeForStatus(res.status),
          wpErrorMessage(body, res.status),
          {
            status: res.status,
          },
        );
        if (!RETRYABLE_STATUS.has(res.status) || attempt === attempts) throw error;
        lastError = error;
        await this.sleep(this.backoff(attempt, res));
      } catch (error) {
        if (error instanceof FluentSuiteError) {
          if (error.status !== undefined || attempt === attempts) throw error;
          if (error.code !== "network_error" && error.code !== "timeout") throw error;
        } else if (attempt === attempts) {
          throw error;
        }
        if (options.signal?.aborted) throw error;
        lastError = error;
        await this.sleep(this.backoff(attempt));
      }
    }
    throw lastError;
  }

  private async send<T>(
    method: HttpMethod,
    url: URL,
    options: RequestOptions<T>,
  ): Promise<Response> {
    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const started = Date.now();
    try {
      const res = await this.fetchImpl(
        new Request(url, { method, headers, body, signal: AbortSignal.any(signals) }),
      );
      // Log the route shape only: no query string, no body, no host credentials.
      this.logger.debug("wp request", {
        method,
        route: url.pathname.replace(/\/\d+(?=\/|$)/g, "/:id"),
        status: res.status,
        ms: Date.now() - started,
      });
      return res;
    } catch (cause) {
      if (options.signal?.aborted) {
        throw new FluentSuiteError("timeout", "The request was cancelled.", { cause });
      }
      if (cause instanceof DOMException && cause.name === "TimeoutError") {
        throw new FluentSuiteError(
          "timeout",
          `WordPress did not answer within ${this.timeoutMs} ms.`,
          {
            cause,
          },
        );
      }
      throw new FluentSuiteError("network_error", "Could not reach the WordPress site.", { cause });
    }
  }

  private async parse<T>(res: Response, schema: z.ZodType<T> | undefined): Promise<WpResponse<T>> {
    const text = await res.text();
    let json: unknown;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch (cause) {
      throw new FluentSuiteError(
        "upstream_error",
        "WordPress returned a response that is not JSON. A security plugin or a PHP notice may be interfering.",
        { cause, status: res.status },
      );
    }
    let data = json as T;
    if (schema) {
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        const where = parsed.error.issues
          .slice(0, 3)
          .map((i) => i.path.join(".") || "(root)")
          .join(", ");
        throw new FluentSuiteError(
          "upstream_error",
          `WordPress returned an unexpected response shape (at ${where}). The plugin version may be unsupported.`,
          { status: res.status },
        );
      }
      data = parsed.data;
    }
    return {
      data,
      status: res.status,
      total: headerInt(res, "X-WP-Total"),
      totalPages: headerInt(res, "X-WP-TotalPages"),
    };
  }

  private backoff(attempt: number, res?: Response): number {
    const retryAfter = res?.headers.get("Retry-After");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
    const base = 250 * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * base);
  }
}

/** Convenience wrapper bound to a REST namespace. */
export class NamespacedClient {
  constructor(
    readonly wp: WordPressClient,
    readonly ns: string,
  ) {}

  private path(route: string): string {
    return `${this.ns.replace(/\/+$/, "")}/${route.replace(/^\/+/, "")}`;
  }

  async get<T = unknown>(route: string, options?: Omit<RequestOptions<T>, "body">): Promise<T> {
    return (await this.wp.request<T>("GET", this.path(route), options)).data;
  }

  async getWithMeta<T = unknown>(
    route: string,
    options?: Omit<RequestOptions<T>, "body">,
  ): Promise<WpResponse<T>> {
    return this.wp.request<T>("GET", this.path(route), options);
  }

  async post<T = unknown>(route: string, options?: RequestOptions<T>): Promise<T> {
    return (await this.wp.request<T>("POST", this.path(route), options)).data;
  }

  async put<T = unknown>(route: string, options?: RequestOptions<T>): Promise<T> {
    return (await this.wp.request<T>("PUT", this.path(route), options)).data;
  }

  async delete<T = unknown>(route: string, options?: RequestOptions<T>): Promise<T> {
    return (await this.wp.request<T>("DELETE", this.path(route), options)).data;
  }
}
