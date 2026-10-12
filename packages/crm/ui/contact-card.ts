// MCP Apps view for crm_contact_profile. Renders the tool's structured content as a contact card.
import { h, startView } from "@fluentsuite/core/ui-kit";
import type { ContactProfile } from "../src/tools/contact-profile.js";

const date = (value: string | null) => (value ? value.slice(0, 10) : "never");

function chips(items: string[]) {
  return items.length
    ? items.map((t) => h("span", { class: "chip" }, t))
    : h("span", { class: "muted" }, "none");
}

void startView<ContactProfile>("FluentSuite contact card", (p, view) => {
  const c = p.contact;
  view.show(
    h(
      "div",
      { class: "row" },
      h(
        "div",
        { class: "grow" },
        h("p", { class: "title" }, c.name),
        h("div", { class: "muted" }, c.email, c.location ? ` · ${c.location}` : ""),
      ),
      h("span", { class: `badge status-${c.status}` }, c.status),
    ),
    p.stats &&
      h(
        "div",
        { class: "section stats" },
        h("div", { class: "stat" }, h("b", {}, p.stats.emails), "emails"),
        h("div", { class: "stat" }, h("b", {}, p.stats.opens), "opens"),
        h("div", { class: "stat" }, h("b", {}, p.stats.clicks), "clicks"),
        h("div", { class: "stat" }, h("b", {}, date(c.last_activity)), "last active"),
      ),
    h("div", { class: "section" }, h("h3", {}, "Tags"), chips(c.tags)),
    h("div", { class: "section" }, h("h3", {}, "Lists"), chips(c.lists)),
    p.recent_emails.length > 0 &&
      h(
        "div",
        { class: "section" },
        h("h3", {}, "Recent emails"),
        h(
          "table",
          {},
          h("tr", {}, h("th", {}, "Date"), h("th", {}, "Subject"), h("th", {}, "Engagement")),
          p.recent_emails.map((e) =>
            h(
              "tr",
              {},
              h("td", {}, date(e.date)),
              h("td", {}, e.subject),
              h(
                "td",
                {},
                e.opened ? `opened${e.clicks ? `, ${e.clicks} clicks` : ""}` : "not opened",
              ),
            ),
          ),
        ),
      ),
    p.notes.length > 0 &&
      h(
        "div",
        { class: "section" },
        h("h3", {}, "Notes"),
        p.notes.map((n) =>
          h(
            "div",
            {},
            h("span", { class: "muted" }, `${date(n.date)} · ${n.type ?? "note"} · `),
            n.title,
          ),
        ),
      ),
    h(
      "div",
      { class: "section muted" },
      `Contact #${c.id} · ${c.type ?? "contact"} · created ${date(c.created_at)} · `,
      h(
        "a",
        {
          href: c.url,
          onclick: (e: Event) => {
            e.preventDefault();
            void view.app.openLink({ url: c.url });
          },
        },
        "Open in FluentCRM",
      ),
    ),
  );
});
