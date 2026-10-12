/**
 * Redaction helpers. FluentSuite never logs secrets or customer PII; these helpers are the last
 * line of defence for anything that might end up in a log line or an error message.
 */

const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+)(\.[A-Za-z0-9.-]+)/g;
const BASIC_AUTH_RE = /(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]+/gi;
const APP_PASSWORD_RE = /\b[A-Za-z0-9]{4}(?: [A-Za-z0-9]{4}){5}\b/g;
const URL_CREDENTIALS_RE = /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi;

/** Mask an email address as `j***@e***.com`. */
export function maskEmail(email: string): string {
  return email.replace(EMAIL_RE, (_m, first: string, domain: string, tld: string) => {
    return `${first}***@${domain.charAt(0)}***${tld}`;
  });
}

/** Remove credentials, tokens, Application Passwords and email addresses from free text. */
export function redact(text: string): string {
  return maskEmail(
    text
      .replace(BASIC_AUTH_RE, "$1 [redacted]")
      .replace(URL_CREDENTIALS_RE, "$1[redacted]@")
      .replace(APP_PASSWORD_RE, "[redacted]"),
  );
}

const SENSITIVE_KEYS = new Set([
  "authorization",
  "password",
  "app_password",
  "application_password",
  "token",
  "secret",
  "email",
  "first_name",
  "last_name",
  "full_name",
  "phone",
  "address_line_1",
  "address_line_2",
  "ip",
]);

/** Deep-copy a value, replacing sensitive keys and redacting strings. For log fields only. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "[redacted]" : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}
