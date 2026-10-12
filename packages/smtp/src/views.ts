import { fileURLToPath } from "node:url";
import type { ViewDefinition } from "@fluentsuite/core";

export const ACTION_PREVIEW_URI = "ui://smtp/action-preview.html";

/** Built by `pnpm build:ui` into ui-dist/ from the shared view in packages/core/ui. */
const uiDist = (name: string) => fileURLToPath(new URL(`../ui-dist/${name}`, import.meta.url));

export const smtpViews: readonly ViewDefinition[] = [
  {
    uri: ACTION_PREVIEW_URI,
    name: "smtp-action-preview",
    description:
      "Dry-run preview of a test email, a resend of failed emails or a log deletion, with an Approve button that applies exactly the previewed action.",
    file: uiDist("action-preview.html"),
  },
];
