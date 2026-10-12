import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as z from "zod/v4";
import { FluentSuiteError } from "./errors.js";
import { fingerprint } from "./paging.js";

/**
 * The safety layer.
 *
 * 1. Read-only by default: write tools are not registered unless `writes.enabled` is true.
 * 2. Every write tool accepts `dry_run` (default **true**) and returns a preview first.
 * 3. Bulk, destructive and email-sending actions need a confirmation token. The token is minted by
 *    the dry run and is an HMAC over the tool name and its exact arguments, so the call that
 *    executes must be identical to the one that was previewed. Tokens are stateless (no server
 *    storage) and expire.
 */

export interface WritePolicy {
  enabled: boolean;
  /** Email-sending tools are listed only when this and `enabled` are both true. */
  allowSending: boolean;
  bulkThreshold: number;
  confirmSecret?: string | undefined;
  confirmTtlSeconds: number;
}

/** Input fields every write tool shares. Spread into the tool's zod object. */
export const writeControls = {
  dry_run: z
    .boolean()
    .default(true)
    .describe("Preview only (default). Set to false to apply the change."),
  confirmation_token: z
    .string()
    .max(512)
    .optional()
    .describe("Token from the dry-run preview. Required for bulk, destructive or sending actions."),
};

export interface WriteControls {
  dry_run: boolean;
  confirmation_token?: string | undefined;
}

/** What a write is about to do, computed before anything changes. */
export interface WritePlan {
  /** Human-readable preview lines, shown to the user before confirming. */
  summary: string;
  /** How many records the write touches. */
  affected: number;
  /** Deletes or irreversibly changes data. */
  destructive?: boolean;
  /** Sends or schedules email. Always needs confirmation. */
  sendsEmail?: boolean;
}

export interface ConfirmationTicket {
  token: string;
  expiresAt: string;
}

/** Arguments that identify a write, without the control fields. */
function identity(args: Record<string, unknown>): Record<string, unknown> {
  const { dry_run: _d, confirmation_token: _c, ...rest } = args;
  return rest;
}

export class SafetyGuard {
  private readonly secret: Buffer;

  constructor(
    readonly policy: WritePolicy,
    private readonly now: () => number = Date.now,
  ) {
    this.secret = policy.confirmSecret ? Buffer.from(policy.confirmSecret) : randomBytes(32);
  }

  get writesEnabled(): boolean {
    return this.policy.enabled;
  }

  get sendingEnabled(): boolean {
    return this.policy.enabled && this.policy.allowSending;
  }

  assertWritesEnabled(tool: string): void {
    if (!this.policy.enabled) {
      throw new FluentSuiteError(
        "writes_disabled",
        `${tool} changes data, and writes are disabled.`,
      );
    }
  }

  needsConfirmation(plan: WritePlan): boolean {
    return Boolean(
      plan.destructive || plan.sendsEmail || plan.affected > this.policy.bulkThreshold,
    );
  }

  mint(tool: string, args: Record<string, unknown>): ConfirmationTicket {
    const exp = Math.floor(this.now() / 1000) + this.policy.confirmTtlSeconds;
    const sig = this.sign(tool, exp, identity(args));
    return {
      token: `${exp.toString(36)}.${sig}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  verify(tool: string, args: Record<string, unknown>, token: string | undefined): void {
    if (!token) {
      throw new FluentSuiteError("confirmation_required", `${tool} needs confirmation.`, {
        hint: "Run it with dry_run=true first, show the preview to the user, and pass the confirmation_token once they approve.",
      });
    }
    const [expPart, sig] = token.split(".");
    const exp = expPart ? Number.parseInt(expPart, 36) : Number.NaN;
    const invalid = (why: string) =>
      new FluentSuiteError("confirmation_invalid", `The confirmation token ${why}.`, {
        hint: "Run the dry run again with the exact same arguments to get a fresh token.",
      });
    if (!sig || !Number.isFinite(exp)) throw invalid("is malformed");
    if (exp < Math.floor(this.now() / 1000)) throw invalid("has expired");
    const expected = Buffer.from(this.sign(tool, exp, identity(args)));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw invalid("does not match these arguments");
    }
  }

  private sign(tool: string, exp: number, args: Record<string, unknown>): string {
    return createHmac("sha256", this.secret)
      .update(`${tool}\n${exp}\n${fingerprint(args)}`)
      .digest("base64url");
  }
}

export type WriteOutcome<R> =
  | { status: "preview"; plan: WritePlan; confirmation?: ConfirmationTicket }
  | { status: "applied"; plan: WritePlan; result: R };

/**
 * Run a write through the safety layer: plan → (preview | verify → execute).
 * `plan` must not change anything; `execute` runs only after all checks pass.
 */
export async function guardedWrite<R>(options: {
  guard: SafetyGuard;
  tool: string;
  args: Record<string, unknown> & WriteControls;
  plan: () => Promise<WritePlan>;
  execute: (plan: WritePlan) => Promise<R>;
}): Promise<WriteOutcome<R>> {
  const { guard, tool, args } = options;
  guard.assertWritesEnabled(tool);
  const plan = await options.plan();
  const needsConfirmation = guard.needsConfirmation(plan);
  if (args.dry_run) {
    return needsConfirmation
      ? { status: "preview", plan, confirmation: guard.mint(tool, args) }
      : { status: "preview", plan };
  }
  if (needsConfirmation) guard.verify(tool, args, args.confirmation_token);
  return { status: "applied", plan, result: await options.execute(plan) };
}

/** Standard preview text for a dry run. */
export function previewText(
  tool: string,
  outcome: Extract<WriteOutcome<unknown>, { status: "preview" }>,
): string {
  const lines = [`DRY RUN, nothing changed yet.`, outcome.plan.summary];
  if (outcome.confirmation) {
    lines.push(
      "",
      "This needs the user's explicit approval. Show them the preview above.",
      `If they approve, call ${tool} again with the same arguments, dry_run=false and confirmation_token="${outcome.confirmation.token}" (valid until ${outcome.confirmation.expiresAt}).`,
    );
  } else {
    lines.push("", `To apply, call ${tool} again with the same arguments and dry_run=false.`);
  }
  return lines.join("\n");
}
