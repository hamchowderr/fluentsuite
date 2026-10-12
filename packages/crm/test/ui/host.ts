// A minimal MCP Apps host for browser tests: renders a view in an iframe through the official
// AppBridge, feeds it a tool input and result, and records the tool calls the view makes.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

interface HostWindow extends Window {
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  startHost(
    html: string,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    reply: unknown,
  ): Promise<void>;
}
const w = window as unknown as HostWindow;
w.calls = [];
w.startHost = async (html, toolName, args, result, reply) => {
  const iframe = document.createElement("iframe");
  iframe.style.width = "800px";
  iframe.style.height = "600px";
  iframe.srcdoc = html;
  document.body.append(iframe);
  await new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
  const contentWindow = iframe.contentWindow as Window;
  const bridge = new AppBridge(
    null,
    { name: "fluentsuite-test-host", version: "0.0.0" },
    { serverTools: {}, openLinks: {} },
    {
      hostContext: {
        theme: "light",
        toolInfo: { id: "call-1", tool: { name: toolName, inputSchema: { type: "object" } } },
      },
    },
  );
  bridge.oncalltool = async (params) => {
    w.calls.push({
      name: params.name,
      arguments: (params.arguments ?? {}) as Record<string, unknown>,
    });
    return reply as never;
  };
  bridge.oninitialized = () => {
    void bridge.sendToolInput({ arguments: args });
    void bridge.sendToolResult(result as never);
  };
  await bridge.connect(new PostMessageTransport(contentWindow, contentWindow));
};
