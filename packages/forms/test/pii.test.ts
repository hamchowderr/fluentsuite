import { describe, expect, it } from "vitest";
import type { FieldDef } from "../src/fields.js";
import { parseFields } from "../src/fields.js";
import { fileName, isSensitive, REDACTED, showField, VALUE_LIMIT } from "../src/pii.js";
import { fixture } from "./mock-forms.js";

const field = (name: string, element = "input_text", label = name): FieldDef => ({
  name,
  label,
  element,
  required: false,
});

describe("isSensitive: whole-word name and label patterns", () => {
  const sensitive: Array<[string, string]> = [
    ["tax_id", "Tax ID"],
    ["taxId", "Customer tax id"],
    ["ssn", "SSN"],
    ["field_7", "Social Security Number"],
    ["card_number", "Card number"],
    ["cvv", "CVV"],
    ["iban", "IBAN"],
    ["passport_no", "Passport"],
    ["drivers_license_number", "Driver's license number"],
    ["user_password", "Password"],
    ["api_token", "API token"],
    ["client_secret", "Secret"],
  ];
  for (const [name, label] of sensitive) {
    it(`redacts ${name} / "${label}"`, () => {
      expect(isSensitive({ name, label }, [])).toBe(true);
    });
  }
  const ordinary: Array<[string, string]> = [
    ["businessName", "Business name"],
    ["email", "Email"],
    ["message", "Your Message"],
    ["discount_code", "Discount code"],
    ["cards_count", "How many cards?"],
    ["address1", "Address"],
  ];
  for (const [name, label] of ordinary) {
    it(`keeps ${name} / "${label}"`, () => {
      expect(isSensitive({ name, label }, [])).toBe(false);
    });
  }
  it("adds the owner's patterns from forms.redactFields", () => {
    expect(isSensitive({ name: "dob", label: "Date of birth" }, [])).toBe(false);
    expect(isSensitive({ name: "dob", label: "Date of birth" }, ["date of birth"])).toBe(true);
    expect(isSensitive({ name: "medical_notes", label: "Notes" }, ["medical"])).toBe(true);
  });
});

describe("showField", () => {
  it("upload fields: file names only, never the URL", () => {
    const shown = showField(
      field("attachment", "input_file", "Attachment"),
      [
        "https://forms.example.test/wp-content/uploads/fluentform/fake-3-quote-request.pdf",
        "https://forms.example.test/wp-content/uploads/fluentform/My%20CV.docx",
      ],
      [],
    );
    expect(shown).toEqual({
      kind: "files",
      value: "fake-3-quote-request.pdf, My CV.docx",
      files: ["fake-3-quote-request.pdf", "My CV.docx"],
    });
    expect(JSON.stringify(shown)).not.toMatch(/https?:|wp-content|uploads/);
  });

  it("image uploads too", () => {
    expect(
      showField(field("photo", "input_image"), "https://x.example.com/u/f/photo.jpg?ver=2", []),
    ).toMatchObject({ files: ["photo.jpg"] });
  });

  it("password fields are omitted entirely", () => {
    expect(showField(field("pw", "input_password", "Choose a password"), "hunter2", [])).toEqual({
      kind: "omitted",
    });
  });

  it("signatures show as signed", () => {
    expect(showField(field("sig", "input_signature"), "data:image/png;base64,AAAA", [])).toEqual({
      kind: "value",
      value: "signed",
    });
  });

  it("sensitive fields show [redacted], never the value", () => {
    const shown = showField(field("tax_id", "input_text", "Tax ID"), "FAKE-TAX-0024", []);
    expect(shown).toEqual({ kind: "redacted", value: REDACTED });
    expect(showField(field("tax_id", "input_text", "Tax ID"), "", [])).toEqual({
      kind: "redacted",
      value: "",
    });
  });

  it("masks links and one-time codes in ordinary values", () => {
    expect(
      showField(field("message", "textarea"), "Your verification code is 482913.", []).kind,
    ).toBe("value");
    expect(
      (
        showField(field("message", "textarea"), "Your verification code is 482913.", []) as {
          value: string;
        }
      ).value,
    ).toBe("Your verification code is [masked code].");
    expect(
      (
        showField(
          field("message", "textarea"),
          "Reset: https://example.com/wp-login.php?action=rp&key=FAKEkey9876543210zyxw&login=test",
          [],
        ) as { value: string }
      ).value,
    ).toBe("Reset: https://example.com/wp-login.php?[masked]");
  });

  it("joins names, addresses and checkboxes, and caps long text", () => {
    expect(
      showField(field("names", "input_name"), { first_name: "Ava", last_name: "Thompson" }, []),
    ).toEqual({ kind: "value", value: "Ava Thompson" });
    expect(
      showField(
        field("address1", "address"),
        { address_line_1: "1 Example St", city: "Lisbon", country: "PT" },
        [],
      ),
    ).toEqual({ kind: "value", value: "1 Example St, Lisbon, PT" });
    expect(showField(field("c", "input_checkbox"), ["Kitchen", "Events"], [])).toEqual({
      kind: "value",
      value: "Kitchen, Events",
    });
    const long = (showField(field("m", "textarea"), "word ".repeat(400), []) as { value: string })
      .value;
    expect(long.length).toBeLessThanOrEqual(VALUE_LIMIT);
  });
});

describe("fileName", () => {
  it("handles plain paths", () => {
    expect(fileName("/var/www/uploads/report.pdf")).toBe("report.pdf");
  });
});

describe("parseFields on the recorded forms", () => {
  const forms =
    fixture<Record<string, { form: { form_fields: string } }>>("forms-detail.json").body;
  it("finds payment fields inside containers", () => {
    const donation = Object.values(forms).find((f) => f.form.form_fields.includes("payment_input"));
    const elements = parseFields(donation?.form.form_fields).map((f) => f.element);
    expect(elements).toContain("multi_payment_component");
    expect(elements).toContain("custom_payment_component");
  });
  it("uses the admin label for name fields", () => {
    const contact = Object.values(forms).find((f) => f.form.form_fields.includes("tax_id"));
    const names = parseFields(contact?.form.form_fields).find((f) => f.element === "input_name");
    expect(names?.label).toBe("Name");
  });
});
