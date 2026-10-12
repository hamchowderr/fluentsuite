/**
 * Hides live credentials that logged emails and form entries carry: password-reset, login, magic and
 * verification links, and one-time codes. Everything FluentSuite shows from a logged email or a form entry goes
 * through `maskSecrets` first. Shared by the FluentSMTP and Fluent Forms modules.
 *
 * Masking is deliberately eager: a link or number that only looks like a secret is masked too. A masked
 * link keeps its scheme and host, so the user can still tell what it was.
 */

export const MASK = "[masked]";
export const MASKED_CODE = "[masked code]";

/** Query parameters whose value is a credential (case-insensitive). */
const SECRET_PARAM =
  /^(key|token|.*[_-]token|token[_-].*|.*nonce|code|otp|auth|signature|sig|hash|secret|magic|.*_key|verify|verification|confirm|confirmation|activation|ticket|session|sso|jwt)$/i;

/** Password-reset actions on wp-login.php and similar. */
const SECRET_ACTION = /^(rp|resetpass|reset[_-]?password|confirm_?admin_?email|confirmaction)$/i;

/** Path words that mark reset, login, magic and verification links. */
const SECRET_PATH =
  /(reset|password|passwd|magic|verify|verification|confirm|activate|activation|login|signin|sign-in|auth|token|invite|unsubscribe)/i;

/** A long random-looking path segment or value: 20+ characters of letters/digits/_-, with a digit. */
const RANDOM = /^(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}$/;

/** A shorter token, only counted in reset/login/magic/verify paths: 8+ characters with a digit. */
const SHORT_TOKEN = /^(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{8,}$/;

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;

function maskUrl(raw: string): string {
  // Trailing punctuation belongs to the sentence, not the link.
  const trail = /[.,;:!?]+$/.exec(raw)?.[0] ?? "";
  const link = trail ? raw.slice(0, -trail.length) : raw;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return raw;
  }
  const origin = `${url.protocol}//${url.host}`;
  const segments = url.pathname.split("/").filter(Boolean).map(decodeSafe);
  const pathToken =
    segments.some((s) => RANDOM.test(s)) ||
    (SECRET_PATH.test(url.pathname) && segments.some((s) => SHORT_TOKEN.test(s)));
  if (pathToken) {
    // A token in the path: the whole path goes.
    return `${origin}/${MASK}${trail}`;
  }
  const params = [...url.searchParams.entries()];
  const secretQuery = params.some(
    ([name, value]) =>
      SECRET_PARAM.test(name) ||
      (name.toLowerCase() === "action" && SECRET_ACTION.test(value)) ||
      RANDOM.test(value),
  );
  const fragment = decodeSafe(url.hash.slice(1));
  const secretFragment =
    fragment !== "" && (RANDOM.test(fragment) || /(token|key|code)=/i.test(fragment));
  if (!secretQuery && !secretFragment) return raw;
  return `${origin}${url.pathname}?${MASK}${trail}`;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * One-time codes: 4–8 digits (optionally grouped with spaces or dashes), or 6–10 letters and digits mixing
 * both, within a few words of a word like "code", "OTP", "PIN" or "verification".
 */
const CODE_WORDS =
  "(?:code|otp|one[- ]?time|passcode|pass code|pin|verification|verify|security code|2fa|two[- ]factor|token|login code|sign[- ]in code)";
const DIGITS = "\\d(?:[ -]?\\d){3,7}";
const ALNUM = "(?=[A-Z0-9]*\\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,10}";
const CODE_AFTER = new RegExp(
  `(\\b${CODE_WORDS}\\b[^\\n\\d]{0,30}?)(?<![\\w#])(${DIGITS}|${ALNUM})(?![\\w-])`,
  "gi",
);
const CODE_BEFORE = new RegExp(
  `(?<![\\w#])(${DIGITS})(?![\\w-])(\\s+(?:is|=|:)?\\s*(?:your|the)?\\s*${CODE_WORDS}\\b)`,
  "gi",
);

export function maskSecrets(text: string): string {
  return text
    .replace(URL_RE, maskUrl)
    .replace(CODE_AFTER, (_m, lead: string) => `${lead}${MASKED_CODE}`)
    .replace(CODE_BEFORE, (_m, _code: string, tail: string) => `${MASKED_CODE}${tail}`);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Plain text from an HTML email body. Links keep their address next to their text ("Reset (https://…)"),
 * so `maskSecrets` can see and mask them.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_m, d: string | undefined, s: string | undefined, u: string | undefined, inner: string) => {
        const href = decodeEntities(d ?? s ?? u ?? "").trim();
        const label = inner.replace(/<[^>]+>/g, "").trim();
        if (!href || href.startsWith("#") || href.startsWith("mailto:")) return label;
        return label && decodeEntities(label) !== href ? `${label} (${href})` : href;
      },
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|blockquote|section|article)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
}
