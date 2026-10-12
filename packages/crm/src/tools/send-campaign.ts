import {
  defineTool,
  FluentSuiteError,
  guardedWrite,
  plural,
  previewText,
  writeControls,
} from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentCrmApi, RecipientSelection } from "../api.js";
import { contactName } from "../segment.js";
import { ACTION_PREVIEW_URI } from "../views.js";

const Input = z.object({
  campaign_id: z
    .number()
    .int()
    .positive()
    .describe("A DRAFT campaign (e.g. from crm_draft_campaign)."),
  schedule_at: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/,
      "Use 'YYYY-MM-DD HH:MM' in the site's timezone.",
    )
    .optional()
    .describe("Schedule for this time (site timezone, 'YYYY-MM-DD HH:MM'). Omit to send now."),
  expected_recipients: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Required to send: the recipient count from the preview. Sending stops if the audience grew.",
    ),
  ...writeControls,
});

const Output = z.object({
  tool: z.string(),
  status: z.enum(["preview", "applied"]),
  campaign_id: z.number(),
  subject: z.string().nullable(),
  recipients: z.number(),
  sample: z.array(z.object({ name: z.string(), email: z.string() })),
  when: z.string(),
  campaign_status: z.string().nullable(),
  confirmation_token: z.string().optional(),
  expires_at: z.string().optional(),
});

function savedSelection(settings: unknown): RecipientSelection {
  const s = (settings ?? {}) as Partial<RecipientSelection> & { sending_filter?: string };
  if (s.sending_filter && s.sending_filter !== "list_tag") {
    throw new FluentSuiteError(
      "invalid_input",
      `This campaign uses a "${s.sending_filter}" audience; only list/tag audiences can be sent from here.`,
      { hint: "Send it from FluentCRM in wp-admin." },
    );
  }
  if (!s.subscribers?.length) {
    throw new FluentSuiteError("invalid_input", "This campaign has no recipients selected.", {
      hint: "Create it with crm_draft_campaign, or pick recipients in FluentCRM.",
    });
  }
  return {
    sending_filter: "list_tag",
    subscribers: s.subscribers,
    excludedSubscribers: s.excludedSubscribers ?? [{ list: null, tag: null }],
  };
}

export function sendCampaignTool(api: FluentCrmApi) {
  return defineTool({
    name: "crm_send_campaign",
    title: "Send or schedule campaign",
    description:
      "Send now, or schedule, an existing DRAFT campaign. Always previews first (subject, recipient count, sample). Sending needs the user's explicit approval: pass the confirmation_token and expected_recipients from the preview. Never sends to more contacts than the preview showed.",
    kind: "write",
    ui: { resourceUri: ACTION_PREVIEW_URI },
    destructive: true,
    sendsEmail: true,
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const campaign = await api.campaign(args.campaign_id, ctx.signal);
      if (campaign.status !== "draft") {
        throw new FluentSuiteError(
          "invalid_input",
          `Campaign #${campaign.id} is "${campaign.status}", not a draft.`,
          {
            hint: "Only draft campaigns can be sent or scheduled.",
          },
        );
      }
      const selection = savedSelection((campaign as { settings?: unknown }).settings);
      const [estimate, sample] = await Promise.all([
        api.campaignRecipientEstimate(campaign.id, ctx.signal),
        api.campaignSample(campaign.id, 5, ctx.signal),
      ]);
      if (estimate === 0)
        throw new FluentSuiteError("invalid_input", "This campaign would reach nobody.");
      const when = args.schedule_at ? `scheduled for ${args.schedule_at} (site time)` : "sent NOW";
      if (!args.dry_run) {
        if (args.expected_recipients === undefined) {
          throw new FluentSuiteError(
            "confirmation_required",
            "expected_recipients is required to send.",
            {
              hint: "Run the preview (dry_run=true) and pass its recipient count with the confirmation token.",
            },
          );
        }
        if (estimate > args.expected_recipients) {
          throw new FluentSuiteError(
            "invalid_input",
            `The audience grew from ${args.expected_recipients} to ${estimate} since the preview. Nothing was sent.`,
            { hint: "Preview again and get the user's approval for the new count." },
          );
        }
      }
      // The token binds the previewed recipient count: the executing call must carry the same number.
      const tokenArgs = {
        ...args,
        expected_recipients: args.dry_run ? estimate : args.expected_recipients,
      };
      const outcome = await guardedWrite({
        guard: ctx.guard,
        tool: "crm_send_campaign",
        args: tokenArgs,
        plan: async () => ({
          summary: [
            `Campaign #${campaign.id} "${campaign.title}" would be ${when}.`,
            `Subject: ${campaign.email_subject ?? "(none)"}`,
            `Recipients: ${plural(estimate, "subscribed contact")}.`,
            sample.length
              ? `Sample: ${sample.map((c) => `${contactName(c)} <${c.email}>`).join(", ")}`
              : "",
            `To approve, also pass expected_recipients=${estimate}.`,
          ]
            .filter(Boolean)
            .join("\n"),
          affected: estimate,
          sendsEmail: true,
        }),
        execute: async () => {
          const queued = await api.queueCampaignRecipients(campaign.id, selection, ctx.signal);
          if (queued > (args.expected_recipients ?? 0)) {
            throw new FluentSuiteError(
              "invalid_input",
              `FluentCRM queued ${queued} recipients, more than the ${args.expected_recipients} approved. The campaign was NOT sent and is still a draft.`,
              { hint: "Review the campaign's recipients in FluentCRM." },
            );
          }
          return api.scheduleCampaign(campaign.id, args.schedule_at, ctx.signal);
        },
      });
      const base = {
        campaign_id: campaign.id,
        subject: campaign.email_subject ?? null,
        recipients: estimate,
        sample: sample.map((c) => ({ name: contactName(c), email: c.email })),
        when,
      };
      if (outcome.status === "preview") {
        return {
          text: previewText("crm_send_campaign", outcome),
          structured: {
            tool: "crm_send_campaign",
            status: "preview" as const,
            ...base,
            campaign_status: campaign.status,
            ...(outcome.confirmation
              ? {
                  confirmation_token: outcome.confirmation.token,
                  expires_at: outcome.confirmation.expiresAt,
                }
              : {}),
          },
        };
      }
      return {
        text: `Campaign #${campaign.id} ${args.schedule_at ? `scheduled for ${args.schedule_at}` : "is sending now"} to ${plural(estimate, "contact")} (status: ${outcome.result}).`,
        structured: {
          tool: "crm_send_campaign",
          status: "applied" as const,
          ...base,
          campaign_status: outcome.result,
        },
      };
    },
  });
}
