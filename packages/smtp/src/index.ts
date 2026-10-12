import { fileURLToPath } from "node:url";
import { loadSkills, type Product } from "@fluentsuite/core";
import { SmtpApi } from "./api.js";
import { deleteEmailLogsTool } from "./tools/delete-logs.js";
import { deliveryReportTool } from "./tools/delivery-report.js";
import { emailDetailTool } from "./tools/email-detail.js";
import { findEmailLogsTool } from "./tools/find-logs.js";
import { resendFailedEmailsTool } from "./tools/resend-failed.js";
import { sendTestEmailTool } from "./tools/send-test-email.js";
import { smtpStatusTool } from "./tools/status.js";
import { smtpViews } from "./views.js";

export { SmtpApi } from "./api.js";
export { htmlToText, maskSecrets } from "./mask.js";
export { ACTION_PREVIEW_URI as SMTP_ACTION_PREVIEW_URI } from "./views.js";

const skillsDir = fileURLToPath(new URL("../skills", import.meta.url));

/** The FluentSMTP product module. Needs the FluentSuite Bridge plugin on the site. */
export const smtpProduct: Product = {
  id: "smtp",
  title: "FluentSMTP",
  instructions:
    "Tools prefixed smtp_ work with FluentSMTP's email sending status and log through the FluentSuite Bridge plugin. Start with smtp_status. Links and one-time codes from logged emails are masked; never try to recover them. The smtp-delivery-troubleshooting skill describes the recommended workflow.",
  tools: ({ wp }) => {
    const api = new SmtpApi(wp);
    return [
      smtpStatusTool(api),
      findEmailLogsTool(api),
      emailDetailTool(api),
      deliveryReportTool(api),
      // Write tools: only listed when writes are enabled. Sending tools need writes.allowSending too,
      // and the site's bridge must allow sending (FLUENTSUITE_BRIDGE_ALLOW_SENDING).
      deleteEmailLogsTool(api),
      sendTestEmailTool(api),
      resendFailedEmailsTool(api),
    ];
  },
  views: smtpViews,
  skills: loadSkills(skillsDir),
};
