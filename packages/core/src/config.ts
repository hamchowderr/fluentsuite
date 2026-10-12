import { readFileSync } from "node:fs";
import * as z from "zod/v4";
import { FluentSuiteError } from "./errors.js";

/** Product ids, in build order. Only products with a package are runnable. */
export const PRODUCT_IDS = [
  "crm",
  "smtp",
  "forms",
  "booking",
  "cart",
  "support",
  "affiliate",
] as const;
export type ProductId = (typeof PRODUCT_IDS)[number];

export const ConfigSchema = z.object({
  site: z.object({
    /** WordPress site root, e.g. https://example.com. The REST root is discovered under it. */
    url: z.url({ protocol: /^https?$/ }),
    /** WordPress username that owns the Application Password. */
    username: z.string().min(1),
    /** WordPress Application Password (Users → Profile → Application Passwords). */
    applicationPassword: z.string().min(1),
    /** Allow plain http:// (local development sites only). */
    allowInsecureHttp: z.boolean().default(false),
  }),
  products: z.array(z.enum(PRODUCT_IDS)).min(1).default(["crm"]),
  writes: z
    .object({
      /** Read-only unless this is true. Write tools are not even listed while it is false. */
      enabled: z.boolean().default(false),
      /**
       * Allow tools that send or schedule email (crm_send_campaign). Off by default, and only effective
       * when writes are enabled too. Sending always needs a confirmation token from a preview.
       */
      allowSending: z.boolean().default(false),
      /** Writes touching more than this many records need an explicit confirmation token. */
      bulkThreshold: z.number().int().min(1).max(10_000).default(10),
      /**
       * HMAC secret for confirmation tokens. Set it when several server instances sit behind a
       * load balancer; otherwise a random per-process secret is used.
       */
      confirmSecret: z.string().min(16).optional(),
      /** How long a confirmation token stays valid. */
      confirmTtlSeconds: z.number().int().min(30).max(3600).default(600),
    })
    .prefault({}),
  request: z
    .object({
      timeoutMs: z.number().int().min(1000).max(120_000).default(20_000),
      /** Retries for idempotent GET requests on 429/5xx/network errors. Writes never retry. */
      retries: z.number().int().min(0).max(5).default(2),
    })
    .prefault({}),
  http: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(0).max(65_535).default(3333),
      path: z.string().startsWith("/").default("/mcp"),
      /** Bearer token required on every HTTP request. Required when binding a non-loopback host. */
      token: z.string().min(24).optional(),
      /** Extra Host header values to accept (for reverse proxies). */
      allowedHosts: z.array(z.string()).default([]),
    })
    .prefault({}),
  forms: z
    .object({
      /**
       * Extra field-name patterns (case-insensitive substrings) whose values the Fluent Forms tools always show
       * as [redacted], on top of the built-in list (password, ssn, card, iban, tax id, passport, …).
       */
      redactFields: z.array(z.string().trim().min(2).max(64)).max(100).default([]),
    })
    .prefault({}),
  logLevel: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

export type FluentSuiteConfig = z.infer<typeof ConfigSchema>;
export type FluentSuiteConfigInput = z.input<typeof ConfigSchema>;

type Env = Record<string, string | undefined>;

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined || value === "") return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function prune<T>(value: T): T {
  if (Array.isArray(value) || value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const pruned = prune(v);
    if (
      pruned &&
      typeof pruned === "object" &&
      !Array.isArray(pruned) &&
      !Object.keys(pruned).length
    )
      continue;
    out[k] = pruned;
  }
  return out as T;
}

function merge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] =
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      b &&
      typeof b === "object" &&
      !Array.isArray(b)
        ? merge(b as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

/** Map FLUENTSUITE_* environment variables onto the config shape. */
export function configFromEnv(env: Env): Record<string, unknown> {
  return prune({
    site: {
      url: env.FLUENTSUITE_SITE_URL,
      username: env.FLUENTSUITE_WP_USER,
      applicationPassword: env.FLUENTSUITE_WP_APP_PASSWORD,
      allowInsecureHttp: bool(env.FLUENTSUITE_ALLOW_INSECURE_HTTP),
    },
    products: list(env.FLUENTSUITE_PRODUCTS),
    writes: {
      enabled: bool(env.FLUENTSUITE_WRITES),
      allowSending: bool(env.FLUENTSUITE_ALLOW_SENDING),
      bulkThreshold: int(env.FLUENTSUITE_BULK_THRESHOLD),
      confirmSecret: env.FLUENTSUITE_CONFIRM_SECRET,
    },
    request: {
      timeoutMs: int(env.FLUENTSUITE_TIMEOUT_MS),
      retries: int(env.FLUENTSUITE_RETRIES),
    },
    http: {
      host: env.FLUENTSUITE_HTTP_HOST,
      port: int(env.FLUENTSUITE_HTTP_PORT ?? env.PORT),
      path: env.FLUENTSUITE_HTTP_PATH,
      token: env.FLUENTSUITE_HTTP_TOKEN,
      allowedHosts: list(env.FLUENTSUITE_HTTP_ALLOWED_HOSTS),
    },
    forms: { redactFields: list(env.FLUENTSUITE_FORMS_REDACT_FIELDS) },
    logLevel: env.FLUENTSUITE_LOG_LEVEL,
  });
}

/** Validate a config object. Error messages name fields but never echo their values. */
export function parseConfig(input: unknown): FluentSuiteConfig {
  const result = ConfigSchema.safeParse(input);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new FluentSuiteError("config_invalid", `Invalid FluentSuite config:\n${problems}`);
  }
  const config = result.data;
  if (config.site.url.startsWith("http://") && !config.site.allowInsecureHttp) {
    throw new FluentSuiteError(
      "config_invalid",
      "site.url uses http://. WordPress Application Passwords need HTTPS; set site.allowInsecureHttp only for local development sites.",
    );
  }
  return config;
}

/**
 * Load config from an optional JSON file (FLUENTSUITE_CONFIG or `path`) merged with environment
 * variables. Environment variables win, so secrets can stay out of the file.
 */
export function loadConfig(options: { env?: Env; path?: string; overrides?: object } = {}) {
  const env = options.env ?? process.env;
  const path = options.path ?? env.FLUENTSUITE_CONFIG;
  let fromFile: Record<string, unknown> = {};
  if (path) {
    try {
      fromFile = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (cause) {
      throw new FluentSuiteError("config_invalid", `Could not read config file at ${path}.`, {
        cause,
      });
    }
  }
  const merged = merge(
    merge(fromFile, configFromEnv(env)),
    (options.overrides ?? {}) as Record<string, unknown>,
  );
  return parseConfig(merged);
}
