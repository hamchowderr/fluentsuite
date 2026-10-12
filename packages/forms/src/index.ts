import { fileURLToPath } from "node:url";
import { loadSkills, type Product } from "@fluentsuite/core";
import { FluentFormsApi } from "./api.js";
import { addEntryNoteTool } from "./tools/add-note.js";
import { deleteEntriesTool } from "./tools/delete-entries.js";
import { entryDetailTool } from "./tools/entry-detail.js";
import { findEntriesTool } from "./tools/find-entries.js";
import { formSummaryTool } from "./tools/form-summary.js";
import { listFormsTool } from "./tools/list-forms.js";
import { reportTool } from "./tools/report.js";
import { updateEntriesTool } from "./tools/update-entries.js";

export { FluentFormsApi } from "./api.js";
export { DEFAULT_REDACT_PATTERNS, isSensitive, showField } from "./pii.js";

const skillsDir = fileURLToPath(new URL("../skills", import.meta.url));

/** The Fluent Forms product module. Uses Fluent Forms' own REST API; never submits forms or creates entries. */
export const formsProduct: Product = {
  id: "forms",
  title: "Fluent Forms",
  instructions:
    "Tools prefixed forms_ read Fluent Forms forms and entries. Find a form with forms_list, entries with forms_find_entries, and one entry with forms_entry_detail. Entry values follow privacy rules: uploads are file names only, password fields are never shown, sensitive fields are [redacted], and links and one-time codes are masked; never try to recover them. No tool submits a form or creates an entry. The forms-inbox-triage skill describes the recommended workflow.",
  tools: ({ wp, config }) => {
    const api = new FluentFormsApi(wp);
    return [
      listFormsTool(api),
      formSummaryTool(api),
      findEntriesTool(api),
      entryDetailTool(api, config.forms.redactFields),
      reportTool(api),
      // Write tools: only listed when writes are enabled. None of them sends email.
      updateEntriesTool(api),
      addEntryNoteTool(api),
      deleteEntriesTool(api),
    ];
  },
  skills: loadSkills(skillsDir),
};
