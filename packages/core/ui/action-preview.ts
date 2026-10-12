// MCP Apps view for segment previews and write-tool dry runs, with an Approve button. Shared by the
// products: each builds it into its own ui-dist and serves it under its own ui:// URI.
//
// Approve re-calls the same tool through the host with the same arguments, dry_run=false and the
// confirmation token from the preview (plus expected_recipients for sends). The server checks the
// token exactly as it does for a model-made call, so the view adds convenience, not authority.
import { h, startView, type ViewHandle } from "./kit.js";

/** A sample row. Products send the fields they have; the table shows the columns present. */
type Row = Record<string, unknown>;

const COLUMNS: Array<[key: string, label: string]> = [
  ["name", "Name"],
  ["email", "Email"],
  ["to", "To"],
  ["subject", "Subject"],
  ["status", "Status"],
];

interface Data {
  tool?: string;
  status?: "preview" | "applied";
  confirmation_token?: string;
  expires_at?: string;
  recipients?: number;
  affected?: number;
  // segment preview
  segment?: string;
  count?: number;
  excluded?: number;
  by_status?: Record<string, number>;
  sample?: Row[];
}

let lastArgs: Record<string, unknown> = {};

function lines(text: string) {
  return text
    .split("\n")
    .filter(
      (l) =>
        l.trim() &&
        !/^(This needs the user's|If they approve|To apply, call|To approve, also pass)/.test(l),
    )
    .map((l) => (l.startsWith("- ") ? h("li", {}, l.slice(2)) : h("p", { class: "line" }, l)));
}

const cell = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v));

function sampleTable(rows: Row[]) {
  const columns = COLUMNS.filter(([key]) => rows.some((r) => r[key] !== undefined));
  return h(
    "table",
    {},
    h(
      "tr",
      {},
      columns.map(([, label]) => h("th", {}, label)),
    ),
    rows.map((r) =>
      h(
        "tr",
        {},
        columns.map(([key]) => h("td", {}, cell(r[key]))),
      ),
    ),
  );
}

function renderSegment(d: Data, view: ViewHandle) {
  view.show(
    h("p", { class: "title" }, d.segment ?? "Segment"),
    h(
      "div",
      { class: "section stats" },
      h("div", { class: "stat" }, h("b", {}, d.count ?? 0), "contacts"),
      d.excluded ? h("div", { class: "stat" }, h("b", {}, d.excluded), "excluded") : null,
      Object.entries(d.by_status ?? {}).map(([k, v]) =>
        h("div", { class: "stat" }, h("b", {}, v), k),
      ),
    ),
    d.sample?.length
      ? h("div", { class: "section" }, h("h3", {}, "Sample"), sampleTable(d.sample))
      : null,
  );
}

function renderAction(d: Data, view: ViewHandle, text: string) {
  const tool = d.tool ?? view.toolName();
  const status = h("div", { class: "muted" }, "");
  const approve = h("button", { class: "primary" }, d.confirmation_token ? "Approve" : "Apply");
  const cancel = h("button", {}, "Cancel");
  // Nothing to approve when the preview found nothing to change.
  const nothing = d.count === 0 || d.affected === 0;
  const actions =
    d.status === "preview" && tool && !nothing
      ? h("div", { class: "row section" }, approve, cancel, status)
      : null;

  approve.addEventListener("click", async () => {
    approve.setAttribute("disabled", "");
    cancel.setAttribute("disabled", "");
    status.textContent = "Working…";
    const args: Record<string, unknown> = { ...lastArgs, dry_run: false };
    if (d.confirmation_token) args.confirmation_token = d.confirmation_token;
    if (tool === "crm_send_campaign" && d.recipients !== undefined)
      args.expected_recipients = d.recipients;
    try {
      const result = await view.app.callServerTool({ name: tool ?? "", arguments: args });
      const out = result.content?.map((c) => ("text" in c ? c.text : "")).join("\n") ?? "";
      status.textContent = result.isError ? out : out || "Done.";
      status.className = result.isError ? "error" : "status-subscribed";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Failed.";
      status.className = "error";
      approve.removeAttribute("disabled");
    }
  });
  cancel.addEventListener("click", () => {
    approve.setAttribute("disabled", "");
    cancel.setAttribute("disabled", "");
    status.textContent = "Cancelled. Nothing was changed.";
  });

  view.show(
    h(
      "div",
      { class: "row" },
      h(
        "p",
        { class: "title grow" },
        d.status === "applied" ? "Done" : "Preview: nothing changed yet",
      ),
      d.confirmation_token ? h("span", { class: "badge status-pending" }, "needs approval") : null,
    ),
    h("div", { class: "section" }, h("ul", {}, lines(text))),
    d.sample?.length
      ? h("div", { class: "section" }, h("h3", {}, "Sample"), sampleTable(d.sample))
      : null,
    d.expires_at && d.status === "preview"
      ? h("div", { class: "muted" }, `Approval valid until ${d.expires_at}`)
      : null,
    actions,
  );
}

void startView<Data>(
  "FluentSuite action preview",
  (data, view, text) => {
    if (data.count !== undefined && data.status === undefined) renderSegment(data, view);
    else renderAction(data, view, text);
  },
  {
    onInput: (args) => {
      lastArgs = args;
    },
  },
);
