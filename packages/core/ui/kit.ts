/**
 * FluentSuite MCP Apps UI kit (browser side). Bundled into each view at build time.
 *
 * Views are small and framework-free: they receive the tool's `structuredContent`, render it with
 * the `h` helper (which always escapes text), follow the host's theme, and may call server tools
 * back through the host (for example an "Approve" button that re-runs a write with its token).
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";

type Child = Node | string | number | null | undefined | false | Child[];

/** Create an element. Strings are always inserted as text, never as HTML. */
export function h(
  tag: string,
  attrs: Record<string, string | boolean | ((e: Event) => void) | undefined> = {},
  ...children: Child[]
): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") el.addEventListener(key.replace(/^on/, ""), value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }
  const append = (child: Child): void => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) child.forEach(append);
    else el.append(child instanceof Node ? child : String(child));
  };
  children.forEach(append);
  return el;
}

function applyContext(ctx: McpUiHostContext | undefined): void {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

export interface ViewHandle {
  app: App;
  /** Name of the tool whose result is shown, when the host tells us. */
  toolName(): string | undefined;
  root: HTMLElement;
  /** Replace the view's content. */
  show(...children: Child[]): void;
}

/**
 * Start a view: connect to the host, follow its theme, and render each tool result.
 * `render` receives the tool's structured content; errors render as plain text.
 */
export async function startView<T>(
  name: string,
  render: (data: T, view: ViewHandle, text: string) => void,
  options: { onInput?: (args: Record<string, unknown>) => void } = {},
): Promise<ViewHandle> {
  const root = document.getElementById("app") ?? document.body;
  const app = new App({ name, version: "0.1.0" });
  const view: ViewHandle = {
    app,
    toolName: () => app.getHostContext()?.toolInfo?.tool.name,
    root,
    show: (...children) =>
      root.replaceChildren(
        ...children
          .flat(10)
          .filter((c): c is Node | string => c !== null && c !== undefined && c !== false)
          .map((c) => (typeof c === "number" ? String(c) : c)),
      ),
  };
  app.ontoolresult = (result) => {
    if (result.isError || !result.structuredContent) {
      const text = result.content?.find((c) => c.type === "text");
      view.show(
        h("div", { class: "error" }, text && "text" in text ? text.text : "Nothing to show."),
      );
      return;
    }
    const text = result.content
      ?.map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
      .join("\n");
    render(result.structuredContent as T, view, text ?? "");
  };
  if (options.onInput) {
    const onInput = options.onInput;
    app.ontoolinput = (params) => onInput((params.arguments ?? {}) as Record<string, unknown>);
  }
  app.onhostcontextchanged = applyContext;
  await app.connect();
  applyContext(app.getHostContext());
  return view;
}
