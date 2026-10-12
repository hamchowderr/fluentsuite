import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { createCrmTestServer } from "./helpers.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("CRM skills", () => {
  it("ships its playbooks over skills/list with valid frontmatter", async () => {
    const conn = await createCrmTestServer().connect();
    close = conn.close;
    const list = await conn.client.request(
      { method: "skills/list", params: {} },
      z.looseObject({
        skills: z.array(
          z.looseObject({ uri: z.string(), frontmatter: z.record(z.string(), z.unknown()) }),
        ),
      }),
    );
    const names = list.skills.map((s) => s.frontmatter.name);
    expect(names).toEqual([
      "crm-new-lead-follow-up",
      "crm-tagging-conventions",
      "crm-win-back-campaign",
    ]);
    for (const skill of list.skills) {
      expect(skill.uri).toBe(`skill://${String(skill.frontmatter.name)}/SKILL.md`);
      expect(String(skill.frontmatter.description).length).toBeGreaterThan(20);
    }
  });
});
