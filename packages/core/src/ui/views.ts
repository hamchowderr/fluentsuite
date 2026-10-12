import { readFile } from "node:fs/promises";
import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";

/**
 * MCP Apps UI kit (server side).
 *
 * A view is a single self-contained HTML file (script and styles inlined) served as a `ui://`
 * resource with the MCP Apps MIME type. Tools point at it via `_meta.ui.resourceUri`. Views use
 * the host's theme variables, so they look native in each host. Every tool with a view still
 * returns complete text, so hosts without MCP Apps lose nothing but the visuals.
 */

export interface ViewDefinition {
  /** `ui://<product>/<name>.html` */
  uri: string;
  name: string;
  description: string;
  /** Path to the built HTML file. */
  file: string;
}

export function registerViews(server: McpServer, views: readonly ViewDefinition[]): void {
  for (const view of views) {
    registerAppResource(
      server,
      view.name,
      view.uri,
      {
        mimeType: RESOURCE_MIME_TYPE,
        description: view.description,
        // Views never load remote code or call out to the network.
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
      },
      async () => ({
        contents: [
          { uri: view.uri, mimeType: RESOURCE_MIME_TYPE, text: await readFile(view.file, "utf8") },
        ],
      }),
    );
  }
}
