import { resolve } from "node:path";
// @ts-expect-error: plain ESM build script without type declarations.
import { buildViews } from "./packages/core/scripts/build-views.mjs";

/** Build MCP Apps views once before the suite, so view resources serve real bundles. */
export default async function setup(): Promise<void> {
  await buildViews(resolve("packages/crm/ui-dist"), [
    resolve("packages/crm/ui/contact-card.ts"),
    resolve("packages/core/ui/action-preview.ts"),
  ]);
  await buildViews(resolve("packages/smtp/ui-dist"), [
    resolve("packages/core/ui/action-preview.ts"),
  ]);
}
