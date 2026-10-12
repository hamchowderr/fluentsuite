import {
  defineTool,
  guardedWrite,
  plural,
  previewText,
  truncate,
  writeControls,
} from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentCrmApi } from "../api.js";
import { AudienceSchema, describeAudience, toSelection } from "../campaign-audience.js";
import { loadTaxonomies } from "../segment.js";
import { ACTION_PREVIEW_URI } from "../views.js";

const Input = z.object({
  title: z.string().trim().min(1).max(190).describe("Internal campaign name (must be unique)."),
  subject: z.string().trim().min(1).max(190),
  pre_header: z
    .string()
    .trim()
    .max(190)
    .optional()
    .describe("Preview text shown after the subject."),
  body: z
    .string()
    .trim()
    .min(1)
    .max(100_000)
    .describe(
      "Email body. HTML, or plain text (paragraphs separated by blank lines). Merge tags like {{contact.first_name}} work.",
    ),
  audience: AudienceSchema,
  ...writeControls,
});

const Output = z.object({
  tool: z.string(),
  status: z.enum(["preview", "applied"]),
  audience: z.string(),
  estimated_recipients: z.number(),
  campaign_id: z.number().nullable(),
  url: z.string().nullable(),
});

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Plain text becomes simple paragraphs; anything that already looks like HTML is kept as is. */
export function toHtml(body: string): string {
  if (/<[a-z][\s\S]*>/i.test(body)) return body;
  return body
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export function draftCampaignTool(api: FluentCrmApi) {
  return defineTool({
    name: "crm_draft_campaign",
    title: "Draft campaign",
    description:
      "Create a DRAFT email campaign (title, subject, body, audience by lists/tags) and report how many subscribed contacts it would reach. Never sends or schedules; the user reviews it in FluentCRM, or with crm_send_campaign if sending is enabled.",
    kind: "write",
    ui: { resourceUri: ACTION_PREVIEW_URI },
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const tax = await loadTaxonomies(api, ctx.signal);
      const selection = toSelection(args.audience, tax);
      const estimated = await api.estimateRecipients(selection, ctx.signal);
      const audience = describeAudience(args.audience);
      const outcome = await guardedWrite({
        guard: ctx.guard,
        tool: "crm_draft_campaign",
        args,
        plan: async () => ({
          summary: [
            `Create draft campaign "${args.title}" (nothing is sent).`,
            `Subject: ${args.subject}`,
            args.pre_header ? `Preview text: ${args.pre_header}` : "",
            `Audience: ${audience}: about ${plural(estimated, "recipient")}.`,
            `Body: ${truncate(args.body.replace(/<[^>]+>/g, " "), 200)}`,
          ]
            .filter(Boolean)
            .join("\n"),
          affected: 1,
        }),
        execute: async () =>
          api.createDraftCampaign(
            {
              title: args.title,
              subject: args.subject,
              preHeader: args.pre_header,
              body: toHtml(args.body),
            },
            selection,
            ctx.signal,
          ),
      });
      if (outcome.status === "preview") {
        return {
          text: previewText("crm_draft_campaign", outcome),
          structured: {
            tool: "crm_draft_campaign",
            status: "preview" as const,
            audience,
            estimated_recipients: estimated,
            campaign_id: null,
            url: null,
          },
        };
      }
      const url = `${api.wp.siteUrl.replace(/\/+$/, "")}/wp-admin/admin.php?page=fluentcrm-admin#/email/campaigns/${outcome.result.id}/edit`;
      return {
        text: `Draft campaign #${outcome.result.id} created for ${plural(outcome.result.recipients, "recipient")}. Nothing was sent. Review it: ${url}`,
        structured: {
          tool: "crm_draft_campaign",
          status: "applied" as const,
          audience,
          estimated_recipients: outcome.result.recipients,
          campaign_id: outcome.result.id,
          url,
        },
      };
    },
  });
}
