/**
 * Field definitions from a Fluent Forms form's `form_fields` JSON. Walks containers and columns. Payment
 * elements are included here (Fluent Forms' `submissions/resources` leaves them out).
 */

export interface FieldDef {
  /** The key the value is stored under in an entry's response. */
  name: string;
  label: string;
  /** Fluent Forms element, e.g. input_email, input_file, multi_payment_component. */
  element: string;
  required: boolean;
}

interface RawField {
  element?: string;
  attributes?: { name?: string };
  settings?: {
    label?: string;
    admin_field_label?: string;
    validation_rules?: { required?: { value?: unknown } };
  };
  columns?: Array<{ fields?: RawField[] }>;
  fields?: RawField[] | Record<string, RawField>;
}

/** Elements that carry no entry value. */
const LAYOUT = new Set([
  "container",
  "section_break",
  "custom_html",
  "shortcode",
  "form_step",
  "recaptcha",
  "hcaptcha",
  "turnstile",
  "action_hook",
  "accordion",
  "save_progress_button",
]);

export function parseFields(formFieldsJson: string | null | undefined): FieldDef[] {
  if (!formFieldsJson) return [];
  let parsed: { fields?: RawField[] };
  try {
    parsed = JSON.parse(formFieldsJson);
  } catch {
    return [];
  }
  const out: FieldDef[] = [];
  const walk = (list: RawField[] | undefined) => {
    for (const f of list ?? []) {
      if (f.columns?.length) {
        for (const c of f.columns) walk(c.fields);
        continue;
      }
      const name = f.attributes?.name;
      const element = f.element ?? "";
      if (!name || LAYOUT.has(element)) continue;
      out.push({
        name,
        label: (f.settings?.label || f.settings?.admin_field_label || name)
          .replace(/<[^>]+>/g, "")
          .trim(),
        element,
        required: Boolean(f.settings?.validation_rules?.required?.value),
      });
    }
  };
  walk(parsed.fields);
  return out;
}

export const isPaymentElement = (element: string) =>
  /payment|item_quantity|subscription/.test(element);
