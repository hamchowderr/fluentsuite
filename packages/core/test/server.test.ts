import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { parseConfig } from "../src/config.js";
import { FluentSuiteError } from "../src/errors.js";
import { guardedWrite, previewText, writeControls } from "../src/safety.js";
import { createServerFactory, type Product } from "../src/server.js";
import { loadSkills, SKILLS_EXTENSION_ID } from "../src/skills.js";
import { connectInProcess, textOf } from "../src/testing.js";
import { defineTool } from "../src/tool.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

const demoProduct: Product = {
  id: "crm",
  title: "Demo",
  instructions: "Demo tools.",
  views: [
    {
      uri: "ui://demo/demo.html",
      name: "demo-view",
      description: "Demo view",
      file: `${fixtures}views/demo.html`,
    },
  ],
  skills: loadSkills(`${fixtures}skills`),
  tools: () => [
    defineTool({
      name: "demo_echo",
      title: "Echo",
      description: "Echo a word.",
      kind: "read",
      input: z.object({ word: z.string().min(1) }),
      output: z.object({ word: z.string() }),
      ui: { resourceUri: "ui://demo/demo.html" },
      handler: async ({ word }) => {
        if (word === "boom") throw new FluentSuiteError("not_found", "No such word.");
        return { text: `You said ${word}`, structured: { word } };
      },
    }),
    defineTool({
      name: "demo_write",
      title: "Write",
      description: "Pretend to write to many records.",
      kind: "write",
      input: z.object({ count: z.number().int().min(1), ...writeControls }),
      handler: async (args, ctx) => {
        const outcome = await guardedWrite({
          guard: ctx.guard,
          tool: "demo_write",
          args,
          plan: async () => ({
            summary: `Would touch ${args.count} records.`,
            affected: args.count,
          }),
          execute: async () => args.count,
        });
        return {
          text:
            outcome.status === "preview"
              ? previewText("demo_write", outcome)
              : `Touched ${outcome.result}.`,
        };
      },
    }),
  ],
};

function config(writes: boolean) {
  return parseConfig({
    site: { url: "https://crm.example.test", username: "admin", applicationPassword: "x" },
    writes: { enabled: writes },
    logLevel: "silent",
  });
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function connect(writes: boolean) {
  const conn = await connectInProcess(
    createServerFactory({ config: config(writes), products: [demoProduct] }),
  );
  close = conn.close;
  return conn.client;
}

describe("server assembly (MCP 2026-07-28, in-process)", () => {
  it("negotiates the modern era and advertises the Skills extension", async () => {
    const client = await connect(false);
    expect(client.getProtocolEra()).toBe("modern");
    const caps = client.getServerCapabilities();
    expect(caps?.extensions?.[SKILLS_EXTENSION_ID]).toEqual({ directoryRead: false });
    expect(client.getInstructions()).toContain("READ-ONLY");
  });

  it("hides write tools while read-only and annotates read tools", async () => {
    const client = await connect(false);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["demo_echo"]);
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools[0]?._meta).toMatchObject({ ui: { resourceUri: "ui://demo/demo.html" } });
  });

  it("returns text plus structured content, and safe isError results", async () => {
    const client = await connect(false);
    const ok = await client.callTool({ name: "demo_echo", arguments: { word: "hi" } });
    expect(textOf(ok)).toBe("You said hi");
    expect(ok.structuredContent).toEqual({ word: "hi" });
    const bad = await client.callTool({ name: "demo_echo", arguments: { word: "boom" } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toBe("Error (not_found): No such word.");
    const invalid = await client.callTool({ name: "demo_echo", arguments: { word: "" } });
    expect(invalid.isError).toBe(true);
  });

  it("previews writes first and requires the confirmation token for bulk changes", async () => {
    const client = await connect(true);
    const preview = await client.callTool({ name: "demo_write", arguments: { count: 50 } });
    const text = textOf(preview);
    expect(text).toContain("DRY RUN");
    const token = /confirmation_token="([^"]+)"/.exec(text)?.[1];
    expect(token).toBeDefined();
    const refused = await client.callTool({
      name: "demo_write",
      arguments: { count: 50, dry_run: false },
    });
    expect(textOf(refused)).toContain("confirmation_required");
    const applied = await client.callTool({
      name: "demo_write",
      arguments: { count: 50, dry_run: false, confirmation_token: token },
    });
    expect(textOf(applied)).toBe("Touched 50.");
  });

  it("serves skills via skills/list, skills/get and resources/read with matching digests", async () => {
    const client = await connect(false);
    const SkillsList = z.looseObject({
      skills: z.array(z.any()),
      ttlMs: z.number(),
      cacheScope: z.string(),
    });
    const list = await client.request({ method: "skills/list", params: {} }, SkillsList);
    expect(list.cacheScope).toBe("public");
    const entry = list.skills[0];
    expect(entry.uri).toBe("skill://demo-skill/SKILL.md");
    expect(entry.frontmatter).toEqual({
      name: "demo-skill",
      description: "A demo skill used by the core test suite.",
      metadata: { owner: "tests" },
    });
    expect(entry.resources.map((r: { uri: string }) => r.uri)).toEqual([
      "skill://demo-skill/SKILL.md",
      "skill://demo-skill/references/notes.md",
    ]);
    for (const manifest of entry.resources as Array<{
      uri: string;
      digest: string;
      size: number;
    }>) {
      const read = await client.readResource({ uri: manifest.uri });
      const bytes = Buffer.from((read.contents[0] as { text: string }).text, "utf8");
      expect(bytes.byteLength).toBe(manifest.size);
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(manifest.digest);
    }

    const got = await client.request(
      { method: "skills/get", params: { uri: "skill://demo-skill/SKILL.md" } },
      z.looseObject({ skill: z.any() }),
    );
    expect(got.skill).toEqual(entry);
    await expect(
      client.request(
        { method: "skills/get", params: { uri: "skill://nope/SKILL.md" } },
        z.looseObject({}),
      ),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("serves MCP Apps views with the MCP Apps MIME type", async () => {
    const client = await connect(false);
    const read = await client.readResource({ uri: "ui://demo/demo.html" });
    expect(read.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
    expect((read.contents[0] as { text: string }).text).toContain("demo view");
  });
});
