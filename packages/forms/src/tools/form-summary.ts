import { defineTool, maskEmail } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentFormsApi, Notification } from "../api.js";
import { isPaymentElement } from "../fields.js";

const Input = z.object({ form_id: z.number().int().positive().describe("From forms_list.") });

const Output = z.object({
  id: z.number(),
  title: z.string(),
  status: z.string(),
  takes_payments: z.boolean(),
  confirmation: z
    .string()
    .describe("What people see after submitting: same page, a page, or a URL."),
  fields: z.array(
    z.object({ name: z.string(), label: z.string(), type: z.string(), required: z.boolean() }),
  ),
  notifications: z.array(z.object({ name: z.string(), enabled: z.boolean(), send_to: z.string() })),
  integrations: z.array(z.object({ name: z.string(), provider: z.string(), enabled: z.boolean() })),
});

/** Who a notification goes to, with any literal address masked. */
function recipients(n: Notification): string {
  const to = n.value.sendTo;
  if (!to) return "unknown";
  if (to.type === "field") return `the address in field "${to.field ?? "?"}"`;
  if (to.type === "routing") return "conditional routing";
  const list = (to.email ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("{") ? s : maskEmail(s)));
  return list.length ? list.join(", ") : "nobody set";
}

const on = (v: unknown) => v === true || v === "true" || v === 1 || v === "1" || v === "yes";

export function formSummaryTool(api: FluentFormsApi) {
  return defineTool({
    name: "forms_form_summary",
    title: "Form summary",
    description:
      "One Fluent Forms form: its fields (label, type, required), which email notifications are set up (recipients masked), which integration feeds are attached (names only, never settings or keys), whether it takes payments, and the confirmation type.",
    kind: "read",
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const [form, notes, feeds] = await Promise.all([
        api.form(args.form_id, ctx.signal),
        api.notifications(args.form_id, ctx.signal),
        api.feeds(args.form_id, ctx.signal),
      ]);
      const confirmation = (() => {
        const c = (form.settings.confirmation ?? {}) as Record<string, unknown>;
        if (c.redirectTo === "customPage") return "redirect to a page";
        if (c.redirectTo === "customUrl") return "redirect to a URL";
        return "message on the same page";
      })();
      const notifications = notes.map((n) => ({
        name: n.value.name ?? "(unnamed)",
        enabled: on(n.value.enabled),
        send_to: recipients(n),
      }));
      const integrations = feeds.map((f) => ({
        name: f.name,
        provider: f.provider,
        enabled: f.enabled,
      }));
      const fields = form.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.element,
        required: f.required,
      }));
      const takesPayments = form.hasPayment || form.fields.some((f) => isPaymentElement(f.element));
      const text = [
        `Form #${form.id} "${form.title}" · ${form.status}${takesPayments ? " · takes payments" : ""}`,
        `Fields (${fields.length}): ${fields.map((f) => `${f.label} [${f.type}${f.required ? ", required" : ""}]`).join("; ")}`,
        notifications.length
          ? `Notifications: ${notifications.map((n) => `${n.name} (${n.enabled ? "on" : "off"}) → ${n.send_to}`).join("; ")}`
          : "Notifications: none",
        integrations.length
          ? `Integrations: ${integrations.map((i) => `${i.name} [${i.provider}] (${i.enabled ? "on" : "off"})`).join("; ")}`
          : "Integrations: none",
        `After submitting: ${confirmation}.`,
      ].join("\n");
      return {
        text,
        structured: {
          id: form.id,
          title: form.title,
          status: form.status,
          takes_payments: takesPayments,
          confirmation,
          fields,
          notifications,
          integrations,
        },
      };
    },
  });
}
