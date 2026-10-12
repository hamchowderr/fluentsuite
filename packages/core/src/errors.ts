/**
 * Typed errors for FluentSuite. Every error carries a stable `code` and a message that is safe to
 * show to the model and the user: no secrets, no request bodies, no customer PII.
 */

export type ErrorCode =
  | "config_invalid"
  | "auth_failed"
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "rate_limited"
  | "upstream_error"
  | "network_error"
  | "timeout"
  | "writes_disabled"
  | "confirmation_required"
  | "confirmation_invalid";

export class FluentSuiteError extends Error {
  readonly code: ErrorCode;
  /** A short hint for the model on what to do next. */
  readonly hint: string | undefined;
  /** HTTP status from WordPress, when the error came from the REST API. */
  readonly status: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { hint?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FluentSuiteError";
    this.code = code;
    this.hint = options.hint;
    this.status = options.status;
  }
}

export function isFluentSuiteError(error: unknown): error is FluentSuiteError {
  return error instanceof FluentSuiteError;
}

/** True for WordPress's `rest_no_route` 404: the plugin (or a Pro add-on) that owns the route is not active. */
export function isMissingRoute(error: unknown): boolean {
  return (
    error instanceof FluentSuiteError && error.status === 404 && /no route/i.test(error.message)
  );
}

/** Map an HTTP status from the WordPress REST API to an error code. */
export function codeForStatus(status: number): ErrorCode {
  if (status === 401) return "auth_failed";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "invalid_input";
  if (status === 429) return "rate_limited";
  return "upstream_error";
}

const DEFAULT_HINTS: Partial<Record<ErrorCode, string>> = {
  auth_failed:
    "Check the WordPress username and Application Password in the FluentSuite config. Application Passwords need HTTPS.",
  forbidden: "The WordPress user lacks the FluentCRM permission for this action.",
  rate_limited: "The site is rate limiting requests. Wait a moment and try again.",
  network_error:
    "The WordPress site could not be reached. Check the site URL and that it is online.",
  timeout: "The WordPress site took too long to answer. Try a smaller page size or try again.",
  writes_disabled:
    "This server is read-only. An admin can enable writes in the FluentSuite config (writes.enabled).",
};

export function defaultHint(code: ErrorCode): string | undefined {
  return DEFAULT_HINTS[code];
}

/**
 * Convert any thrown value into a tool-facing message. Unknown errors are not echoed verbatim,
 * because they may contain URLs, payloads or other data we do not want in model context.
 */
export function describeError(error: unknown): { code: ErrorCode; text: string } {
  if (isFluentSuiteError(error)) {
    const hint = error.hint ?? defaultHint(error.code);
    return { code: error.code, text: hint ? `${error.message}\nHint: ${hint}` : error.message };
  }
  return { code: "upstream_error", text: "Unexpected error while talking to WordPress." };
}
