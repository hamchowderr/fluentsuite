import { fileURLToPath } from "node:url";
import { loadSkills, type Product } from "@fluentsuite/core";
import { FluentCrmApi } from "./api.js";
import { addContactNoteTool } from "./tools/add-note.js";
import { audienceSummaryTool } from "./tools/audience-summary.js";
import { campaignOverviewTool } from "./tools/campaign-overview.js";
import { contactProfileTool } from "./tools/contact-profile.js";
import { draftCampaignTool } from "./tools/draft-campaign.js";
import { findContactsTool } from "./tools/find-contacts.js";
import { listMembershipTool, tagContactsTool } from "./tools/membership.js";
import { recentSignupsTool } from "./tools/recent-signups.js";
import { segmentPreviewTool } from "./tools/segment-preview.js";
import { sendCampaignTool } from "./tools/send-campaign.js";
import { sequenceOverviewTool } from "./tools/sequence-overview.js";
import { setContactStatusTool } from "./tools/set-status.js";
import { tagsAndListsTool } from "./tools/tags-and-lists.js";
import { upsertContactTool } from "./tools/upsert-contact.js";
import { crmViews } from "./views.js";

export { FluentCrmApi } from "./api.js";
export { CONTACT_CARD_URI } from "./views.js";

const skillsDir = fileURLToPath(new URL("../skills", import.meta.url));

/** The FluentCRM product module. */
export const crmProduct: Product = {
  id: "crm",
  title: "FluentCRM",
  instructions:
    "Tools prefixed crm_ work with FluentCRM contacts, tags, lists, campaigns and sequences. Look contacts up by exact email when you have it. The crm-* skills describe recommended workflows.",
  tools: ({ wp }) => {
    const api = new FluentCrmApi(wp);
    return [
      contactProfileTool(api),
      findContactsTool(api),
      tagsAndListsTool(api),
      segmentPreviewTool(api),
      campaignOverviewTool(api),
      sequenceOverviewTool(api),
      recentSignupsTool(api),
      audienceSummaryTool(api),
      // Write tools: only listed when writes are enabled. Sending needs writes.allowSending too.
      tagContactsTool(api),
      listMembershipTool(api),
      upsertContactTool(api),
      setContactStatusTool(api),
      addContactNoteTool(api),
      draftCampaignTool(api),
      sendCampaignTool(api),
    ];
  },
  views: crmViews,
  skills: loadSkills(skillsDir),
};
