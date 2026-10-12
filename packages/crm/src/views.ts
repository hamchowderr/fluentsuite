import { fileURLToPath } from "node:url";
import type { ViewDefinition } from "@fluentsuite/core";

export const CONTACT_CARD_URI = "ui://crm/contact-card.html";
export const ACTION_PREVIEW_URI = "ui://crm/action-preview.html";

/** Built by `pnpm build:ui` into ui-dist/ (see packages/core/scripts/build-views.mjs). */
const uiDist = (name: string) => fileURLToPath(new URL(`../ui-dist/${name}`, import.meta.url));

export const crmViews: readonly ViewDefinition[] = [
  {
    uri: CONTACT_CARD_URI,
    name: "crm-contact-card",
    description:
      "Contact card: status, tags, lists, engagement and recent activity for one contact.",
    file: uiDist("contact-card.html"),
  },
  {
    uri: ACTION_PREVIEW_URI,
    name: "crm-action-preview",
    description:
      "Segment preview, and the dry-run preview of bulk changes and campaigns, with an Approve button that applies the previewed change.",
    file: uiDist("action-preview.html"),
  },
];
