import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The MCP Apps action-preview view in a real browser (headless Chromium), hosted by the official
 * ext-apps AppBridge. Proves the Approve button re-calls the tool with dry_run=false and the token.
 */
const viewFile = fileURLToPath(new URL("../../ui-dist/action-preview.html", import.meta.url));
const localChromium = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

let browser: Browser | undefined;
let hostScript = "";
let available = true;

beforeAll(async () => {
  hostScript =
    (
      await build({
        entryPoints: [fileURLToPath(new URL("./host.ts", import.meta.url))],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        logLevel: "silent",
      })
    ).outputFiles[0]?.text ?? "";
  try {
    browser = await chromium.launch(
      existsSync(localChromium) ? { executablePath: localChromium } : {},
    );
  } catch (error) {
    if (process.env.CI) throw error;
    available = false; // No browser on this machine; CI installs one.
  }
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

async function host(
  toolName: string,
  args: Record<string, unknown>,
  structured: Record<string, unknown>,
  text: string,
  reply: unknown,
) {
  if (!browser) throw new Error("no browser");
  const page: Page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body><script>${hostScript}</script></body></html>`);
  await page.evaluate(
    ([html, name, a, result, r]) =>
      (globalThis as unknown as { startHost: (...x: unknown[]) => Promise<void> }).startHost(
        html,
        name,
        a,
        result,
        r,
      ),
    [
      readFileSync(viewFile, "utf8"),
      toolName,
      args,
      { content: [{ type: "text", text }], structuredContent: structured },
      reply,
    ] as const,
  );
  return { page, frame: page.frameLocator("iframe") };
}

describe("action-preview view (browser)", () => {
  it("approves a bulk tag preview with the token and dry_run=false", async (ctx) => {
    if (!available) return ctx.skip();
    const args = { segment: { lists_any: ["Newsletter"] }, add: ["VIP"] };
    const { page, frame } = await host(
      "crm_tag_contacts",
      args,
      {
        tool: "crm_tag_contacts",
        status: "preview",
        affected: 34,
        confirmation_token: "tok.123",
        expires_at: "2026-10-12T03:00:00Z",
      },
      "DRY RUN, nothing changed yet.\nTag contacts: 34 contacts would change.\n- Yara Khan <yara.khan50@example.com> +VIP\nThis needs the user's explicit approval.",
      { content: [{ type: "text", text: "Done. 34 contacts updated." }] },
    );
    await expect.poll(() => frame.getByText("needs approval").count()).toBe(1);
    expect(await frame.getByText("Yara Khan <yara.khan50@example.com> +VIP").count()).toBe(1);
    // The model-facing instruction lines are hidden from people.
    expect(await frame.getByText("needs the user's explicit approval").count()).toBe(0);
    await frame.getByRole("button", { name: "Approve" }).click();
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as { calls: unknown[] }).calls.length))
      .toBe(1);
    const calls = await page.evaluate(() => (globalThis as unknown as { calls: unknown[] }).calls);
    expect(calls).toEqual([
      {
        name: "crm_tag_contacts",
        arguments: { ...args, dry_run: false, confirmation_token: "tok.123" },
      },
    ]);
    await expect.poll(() => frame.getByText("Done. 34 contacts updated.").count()).toBe(1);
    await page.close();
  }, 30_000);

  it("passes expected_recipients when approving a campaign send", async (ctx) => {
    if (!available) return ctx.skip();
    const { page, frame } = await host(
      "crm_send_campaign",
      { campaign_id: 7 },
      {
        tool: "crm_send_campaign",
        status: "preview",
        recipients: 22,
        confirmation_token: "tok.send",
        sample: [{ name: "Xan Moss", email: "xan.moss49@example.com" }],
      },
      "DRY RUN, nothing changed yet.\nCampaign #7 would be sent NOW.\nRecipients: 22 subscribed contacts.",
      { content: [{ type: "text", text: "Campaign #7 is sending now to 22 contacts." }] },
    );
    await frame.getByRole("button", { name: "Approve" }).click();
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as { calls: unknown[] }).calls.length))
      .toBe(1);
    const calls = await page.evaluate(
      () => (globalThis as unknown as { calls: Array<{ arguments: unknown }> }).calls,
    );
    expect(calls[0]?.arguments).toEqual({
      campaign_id: 7,
      dry_run: false,
      confirmation_token: "tok.send",
      expected_recipients: 22,
    });
    await page.close();
  }, 30_000);

  it("Cancel changes nothing", async (ctx) => {
    if (!available) return ctx.skip();
    const { page, frame } = await host(
      "crm_set_contact_status",
      { emails: ["a@example.com"], status: "unsubscribed" },
      { tool: "crm_set_contact_status", status: "preview", confirmation_token: "tok.x" },
      "DRY RUN, nothing changed yet.\nSet status to unsubscribed: 1 contact would change.",
      { content: [] },
    );
    await frame.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(() => frame.getByText("Cancelled. Nothing was changed.").count()).toBe(1);
    expect(
      await page.evaluate(() => (globalThis as unknown as { calls: unknown[] }).calls.length),
    ).toBe(0);
    await page.close();
  }, 30_000);

  it("shared view: approves an SMTP resend with the token and the email columns", async (ctx) => {
    if (!available) return ctx.skip();
    const args = { ids: [30, 27] };
    const { page, frame } = await host(
      "smtp_resend_failed_emails",
      args,
      {
        tool: "smtp_resend_failed_emails",
        status: "preview",
        count: 2,
        confirmation_token: "tok.resend",
        sample: [
          {
            name: "Mia Rossi",
            email: "mia.rossi@example.com",
            subject: "Your order receipt #1026",
          },
        ],
      },
      "DRY RUN, nothing changed yet.\nResend 2 failed emails to their original recipients.",
      { content: [{ type: "text", text: "Resent 2 emails: 2 sent, 0 failed, 0 skipped." }] },
    );
    await expect.poll(() => frame.locator("th", { hasText: "Subject" }).count()).toBe(1);
    expect(await frame.getByText("Your order receipt #1026").count()).toBe(1);
    await frame.getByRole("button", { name: "Approve" }).click();
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as { calls: unknown[] }).calls.length))
      .toBe(1);
    const calls = await page.evaluate(
      () => (globalThis as unknown as { calls: Array<{ arguments: unknown }> }).calls,
    );
    expect(calls[0]?.arguments).toEqual({
      ...args,
      dry_run: false,
      confirmation_token: "tok.resend",
    });
    await page.close();
  }, 30_000);

  it("shared view: no Approve button when a preview found nothing to change", async (ctx) => {
    if (!available) return ctx.skip();
    const { page, frame } = await host(
      "smtp_delete_email_logs",
      { to: "nobody@example.com" },
      { tool: "smtp_delete_email_logs", status: "preview", count: 0, sample: [] },
      "No email logs addressed to nobody@example.com. Nothing to delete.",
      { content: [] },
    );
    await expect.poll(() => frame.getByText("Nothing to delete.").count()).toBe(1);
    expect(await frame.getByRole("button", { name: "Approve" }).count()).toBe(0);
    expect(await frame.getByRole("button", { name: "Apply" }).count()).toBe(0);
    await page.close();
  }, 30_000);

  it("renders a segment preview without an Approve button", async (ctx) => {
    if (!available) return ctx.skip();
    const { page, frame } = await host(
      "crm_segment_preview",
      {},
      {
        segment: "Contacts on Newsletter",
        count: 22,
        excluded: 12,
        by_status: { subscribed: 22 },
        sample: [{ name: "Xan Moss", email: "xan.moss49@example.com", status: "subscribed" }],
      },
      "Contacts on Newsletter: 22 contacts.",
      { content: [] },
    );
    await expect.poll(() => frame.getByText("Contacts on Newsletter").count()).toBe(1);
    expect(await frame.getByRole("button", { name: "Approve" }).count()).toBe(0);
    await page.close();
  }, 30_000);
});
