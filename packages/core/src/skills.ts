import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { parse as parseYaml } from "yaml";
import * as z from "zod/v4";

/**
 * Skills over MCP (SEP-2640, extension `io.modelcontextprotocol/skills`).
 *
 * The TypeScript SDK does not implement this extension yet (tracked upstream in
 * modelcontextprotocol/typescript-sdk#2798), so FluentSuite implements the server side itself:
 *
 * - each skill is a directory with a `SKILL.md` (Agent Skills format) and optional files;
 * - every file is served through `resources/read` as `skill://<name>/<path>`;
 * - `skills/list` and `skills/get` return frontmatter plus a manifest with SHA-256 digests and
 *   byte sizes computed from the exact bytes served;
 * - the extension is declared in capabilities (`server/discover`) with `directoryRead: false`.
 *
 * Skills are loaded once at startup and are immutable while the process runs.
 */

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
const SKILLS_TTL_MS = 300_000;

export interface SkillFile {
  uri: string;
  path: string;
  bytes: Buffer;
  digest: string;
  size: number;
  mimeType: string;
}

export interface Skill {
  name: string;
  uri: string;
  frontmatter: Record<string, unknown>;
  files: SkillFile[];
}

export interface SkillEntry {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: Array<{ uri: string; digest: string; size: number }>;
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MIME: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  csv: "text/csv",
  html: "text/html",
};

function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

/** Parse the YAML frontmatter at the top of a SKILL.md. */
export function parseFrontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match?.[1]) throw new Error("SKILL.md must begin with YAML frontmatter");
  const data: unknown = parseYaml(match[1]);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("SKILL.md frontmatter must be a YAML mapping");
  }
  return data as Record<string, unknown>;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Load every `<dir>/<name>/SKILL.md` skill. Throws on invalid skills so problems show at startup. */
export function loadSkills(root: string): Skill[] {
  const skills: Skill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const skillMd = join(dir, "SKILL.md");
    if (!statSync(skillMd, { throwIfNoEntry: false })?.isFile()) continue;
    const frontmatter = parseFrontmatter(readFileSync(skillMd, "utf8"));
    const name = frontmatter.name;
    if (typeof name !== "string" || !NAME_RE.test(name) || name.length > 64) {
      throw new Error(
        `Skill in ${dir}: frontmatter "name" must be lowercase-hyphenated (max 64 chars)`,
      );
    }
    if (name !== entry.name) {
      throw new Error(`Skill in ${dir}: directory name must match frontmatter name "${name}"`);
    }
    if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
      throw new Error(`Skill "${name}": frontmatter "description" is required`);
    }
    const files = walk(dir).map((full): SkillFile => {
      const path = relative(dir, full).split(sep).join("/");
      const bytes = readFileSync(full);
      return {
        uri: `skill://${name}/${path}`,
        path,
        bytes,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        size: bytes.byteLength,
        mimeType: mimeFor(path),
      };
    });
    // SKILL.md first, then the rest in path order.
    files.sort((a, b) =>
      a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path),
    );
    skills.push({ name, uri: `skill://${name}/SKILL.md`, frontmatter, files });
  }
  return skills;
}

export function skillEntry(skill: Skill): SkillEntry {
  return {
    uri: skill.uri,
    frontmatter: skill.frontmatter,
    resources: skill.files.map((f) => ({ uri: f.uri, digest: f.digest, size: f.size })),
  };
}

const ListParams = z.looseObject({ cursor: z.string().optional() });
const GetParams = z.looseObject({ uri: z.string() });
const ListResult = z.looseObject({ skills: z.array(z.unknown()) });
const GetResult = z.looseObject({ skill: z.unknown() });

/**
 * Serve skills on a server: resources for every file, `skills/list`, `skills/get`, and the
 * extension declaration. Skill names must be unique across products.
 */
export function registerSkills(server: McpServer, skills: readonly Skill[]): void {
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name)) throw new Error(`Duplicate skill name "${skill.name}"`);
    seen.add(skill.name);
  }

  for (const skill of skills) {
    for (const file of skill.files) {
      server.registerResource(
        `${skill.name}/${file.path}`,
        file.uri,
        {
          mimeType: file.mimeType,
          description: file.path === "SKILL.md" ? String(skill.frontmatter.description) : undefined,
        },
        async () => ({
          contents: [
            file.mimeType.startsWith("text/") ||
            file.mimeType.endsWith("json") ||
            file.mimeType.endsWith("yaml")
              ? { uri: file.uri, mimeType: file.mimeType, text: file.bytes.toString("utf8") }
              : { uri: file.uri, mimeType: file.mimeType, blob: file.bytes.toString("base64") },
          ],
        }),
      );
    }
  }

  const byUri = new Map(skills.map((s) => [s.uri, s]));
  const entries = skills.map(skillEntry);
  const cache = {
    resultType: "complete" as const,
    ttlMs: SKILLS_TTL_MS,
    cacheScope: "public" as const,
  };

  server.server.registerCapabilities({
    resources: {},
    extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: false } },
  });
  // All skills fit in one page; the list is small and never split.
  server.server.setRequestHandler(
    "skills/list",
    { params: ListParams, result: ListResult },
    async () => ({
      ...cache,
      skills: entries,
    }),
  );
  server.server.setRequestHandler(
    "skills/get",
    { params: GetParams, result: GetResult },
    async ({ uri }) => {
      const skill = byUri.get(uri);
      if (!skill) throw new ProtocolError(-32602, `Unknown skill: ${uri}`);
      return { ...cache, skill: skillEntry(skill) };
    },
  );
}
