import {
  FluentSuiteError,
  isMissingRoute,
  LaravelPage,
  type NamespacedClient,
  type WordPressClient,
} from "@fluentsuite/core";
import * as z from "zod/v4";

/**
 * Typed access to the FluentCRM REST API (namespace `fluent-crm/v2`).
 *
 * Only what the task-shaped tools need. Schemas are deliberately loose (`looseObject`, optional
 * fields) so minor plugin version differences do not break tools; they pin down only the fields
 * the tools actually read. See docs/reference/fluentcrm-rest-api.md for the endpoint notes.
 */

const Taxonomy = z.looseObject({
  id: z.coerce.number(),
  title: z.string(),
  slug: z.string(),
});
export type Taxonomy = z.infer<typeof Taxonomy>;

const nullableString = z.string().nullish();

export const Subscriber = z.looseObject({
  id: z.coerce.number(),
  email: z.string(),
  first_name: nullableString,
  last_name: nullableString,
  full_name: nullableString,
  status: z.string(),
  contact_type: nullableString,
  source: nullableString,
  phone: nullableString,
  city: nullableString,
  country: nullableString,
  life_time_value: z.coerce.number().nullish(),
  created_at: nullableString,
  last_activity: nullableString,
  tags: z.array(Taxonomy).default([]),
  lists: z.array(Taxonomy).default([]),
  stats: z
    .looseObject({ emails: z.coerce.number(), opens: z.coerce.number(), clicks: z.coerce.number() })
    .optional(),
  custom_values: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
  unsubscribe_reason: nullableString,
});
export type Subscriber = z.infer<typeof Subscriber>;

const ShowResponse = z.looseObject({ subscriber: Subscriber });

const CampaignEmail = z.looseObject({
  id: z.coerce.number(),
  email_subject: nullableString,
  status: nullableString,
  is_open: z.coerce.number().nullish(),
  click_counter: z.coerce.number().nullish(),
  scheduled_at: nullableString,
  created_at: nullableString,
});
export type CampaignEmail = z.infer<typeof CampaignEmail>;

const Note = z.looseObject({
  id: z.coerce.number(),
  title: nullableString,
  type: nullableString,
  created_at: nullableString,
});
export type Note = z.infer<typeof Note>;

const EmailsResponse = z.looseObject({ emails: LaravelPage(CampaignEmail) });
const NotesResponse = z.looseObject({ notes: LaravelPage(Note) });
const ContactsResponse = z.looseObject({ subscribers: LaravelPage(Subscriber) });

const TagRow = Taxonomy.extend({ subscribersCount: z.coerce.number().nullish() });
export type TagRow = z.infer<typeof TagRow>;
const ListRow = Taxonomy.extend({
  totalCount: z.coerce.number().nullish(),
  subscribersCount: z.coerce.number().nullish(),
});
export type ListRow = z.infer<typeof ListRow>;
const TagsResponse = z.looseObject({ tags: LaravelPage(TagRow) });
// GET lists has no paginator: an items array plus pagination.total.
const ListsResponse = z.looseObject({ lists: z.array(ListRow) });

const CampaignStats = z.looseObject({
  total: z.coerce.number().default(0),
  sent: z.coerce.number().default(0),
  views: z.coerce.number().default(0),
  clicks: z.coerce.number().default(0),
  unsubscribers: z.coerce.number().default(0),
});
export const Campaign = z.looseObject({
  id: z.coerce.number(),
  title: z.string(),
  status: z.string(),
  email_subject: nullableString,
  recipients_count: z.coerce.number().nullish(),
  scheduled_at: nullableString,
  created_at: nullableString,
  updated_at: nullableString,
  stats: CampaignStats.optional(),
});
export type Campaign = z.infer<typeof Campaign>;
const CampaignsResponse = z.looseObject({ campaigns: LaravelPage(Campaign) });
const CampaignResponse = z.looseObject({ campaign: Campaign });
// analytics is an object keyed by metric, or [] when nothing has been tracked yet.
const OverviewStats = z.looseObject({
  sent_count: z.coerce.number().default(0),
  analytics: z
    .union([z.record(z.string(), z.looseObject({ total: z.unknown() })), z.array(z.unknown())])
    .default([]),
});
export type OverviewStats = z.infer<typeof OverviewStats>;
const LinkReport = z.looseObject({
  links: z.array(z.looseObject({ url: z.string(), total: z.coerce.number() })).default([]),
});

const SequenceStats = z.looseObject({
  emails: z.coerce.number().default(0),
  subscribers: z.coerce.number().default(0),
});
export const Sequence = z.looseObject({
  id: z.coerce.number(),
  title: z.string(),
  status: z.string(),
  created_at: nullableString,
  stats: SequenceStats.optional(),
});
export type Sequence = z.infer<typeof Sequence>;
const SequenceEmail = z.looseObject({
  id: z.coerce.number(),
  title: nullableString,
  email_subject: nullableString,
  delay: z.coerce.number().nullish(),
  stats: z
    .looseObject({
      sent: z.coerce.number().default(0),
      views: z.coerce.number().default(0),
      clicks: z.coerce.number().default(0),
    })
    .nullish(),
});
export type SequenceEmail = z.infer<typeof SequenceEmail>;
const SequencesResponse = z.looseObject({ sequences: LaravelPage(Sequence) });
const SequenceResponse = z.looseObject({
  sequence: Sequence,
  sequence_emails: z.array(SequenceEmail).default([]),
});

const DashboardStats = z.looseObject({
  stats: z.record(z.string(), z.looseObject({ title: z.string(), count: z.coerce.number() })),
});
// FluentCRM 2.x returns {stats:{date:n}}; 3.x returns {data_sets:[{label, data:{date:n}}]}.
const Series = z.record(z.string(), z.coerce.number());
const SeriesResponse = z.looseObject({
  data_sets: z.array(z.looseObject({ data: Series })).optional(),
  stats: Series.optional(),
});

/** Simple contact filters FluentCRM understands natively (tags and lists by id, ANY within, AND across). */
export interface ContactFilter {
  search?: string | undefined;
  tagIds?: number[] | undefined;
  listIds?: number[] | undefined;
  statuses?: string[] | undefined;
}

/**
 * FluentCRM's list/tag recipient selection for campaigns. Each `subscribers` row is list AND tag
 * ("all" = any); rows are OR'd. `excludedSubscribers` rows remove contacts.
 */
export interface RecipientSelection {
  sending_filter: "list_tag";
  subscribers: Array<{ list: string; tag: string }>;
  excludedSubscribers: Array<{ list: string | null; tag: string | null }>;
}

export const CONTACT_SORTS = ["id", "created_at", "last_activity", "email", "first_name"] as const;
export type ContactSort = (typeof CONTACT_SORTS)[number];

/** True when FluentCRM Pro is missing: the route is simply not registered. Re-exported from core. */
export { isMissingRoute };

export class FluentCrmApi {
  readonly crm: NamespacedClient;

  constructor(readonly wp: WordPressClient) {
    this.crm = wp.namespace("fluent-crm/v2");
  }

  /** Admin URL of a contact, for linking from tool output. */
  contactUrl(id: number): string {
    return `${this.wp.siteUrl.replace(/\/+$/, "")}/wp-admin/admin.php?page=fluentcrm-admin#/subscribers/${id}`;
  }

  /**
   * One contact by id or exact email, with stats and custom field values. FluentCRM answers an
   * unknown contact with HTTP 422 "Subscriber not found"; that becomes a `not_found` error here.
   */
  async getContact(
    by: { id: number } | { email: string },
    signal?: AbortSignal,
  ): Promise<Subscriber> {
    const route = "id" in by ? `subscribers/${by.id}` : "subscribers/0";
    const query = {
      with: ["stats", "subscriber.custom_values"],
      ...("email" in by ? { get_by_email: by.email } : {}),
    };
    try {
      const res = await this.crm.get(route, {
        query,
        schema: ShowResponse,
        ...(signal ? { signal } : {}),
      });
      return res.subscriber;
    } catch (error) {
      if (
        error instanceof FluentSuiteError &&
        (error.status === 404 || (error.status === 422 && /not found/i.test(error.message)))
      ) {
        throw new FluentSuiteError("not_found", "No contact matches that email or id.", {
          status: error.status,
          hint: "Check the spelling, or use crm_find_contacts to search by name.",
        });
      }
      throw error;
    }
  }

  async recentEmails(id: number, limit: number, signal?: AbortSignal): Promise<CampaignEmail[]> {
    const res = await this.crm.get(`subscribers/${id}/emails`, {
      query: { per_page: limit, page: 1 },
      schema: EmailsResponse,
      ...(signal ? { signal } : {}),
    });
    return res.emails.data;
  }

  async recentNotes(id: number, limit: number, signal?: AbortSignal): Promise<Note[]> {
    const res = await this.crm.get(`subscribers/${id}/notes`, {
      query: { per_page: limit, page: 1 },
      schema: NotesResponse,
      ...(signal ? { signal } : {}),
    });
    return res.notes.data;
  }

  /** One page of contacts matching simple filters. Tags and lists are included in each row. */
  async listContacts(
    filter: ContactFilter,
    page: { page: number; perPage: number; sortBy?: ContactSort; sortType?: "ASC" | "DESC" },
    signal?: AbortSignal,
  ) {
    const res = await this.crm.get("subscribers", {
      query: {
        search: filter.search,
        tags: filter.tagIds,
        lists: filter.listIds,
        statuses: filter.statuses,
        page: page.page,
        per_page: page.perPage,
        sort_by: page.sortBy ?? "id",
        sort_type: page.sortType ?? "DESC",
      },
      schema: ContactsResponse,
      ...(signal ? { signal } : {}),
    });
    return res.subscribers;
  }

  /** How many contacts match, without fetching them. */
  async countContacts(filter: ContactFilter, signal?: AbortSignal): Promise<number> {
    return (await this.listContacts(filter, { page: 1, perPage: 1 }, signal)).total;
  }

  async tags(signal?: AbortSignal): Promise<TagRow[]> {
    const res = await this.crm.get("tags", {
      query: { per_page: 500, page: 1, sort_by: "title", sort_order: "ASC" },
      schema: TagsResponse,
      ...(signal ? { signal } : {}),
    });
    return res.tags.data;
  }

  async lists(signal?: AbortSignal): Promise<ListRow[]> {
    const res = await this.crm.get("lists", {
      query: { per_page: 500, page: 1, sort_by: "title", sort_order: "ASC" },
      schema: ListsResponse,
      ...(signal ? { signal } : {}),
    });
    return res.lists;
  }

  async campaigns(
    options: {
      page: number;
      perPage: number;
      statuses?: string[] | undefined;
      search?: string | undefined;
    },
    signal?: AbortSignal,
  ) {
    const res = await this.crm.get("campaigns", {
      query: {
        with: ["stats"],
        statuses: options.statuses,
        searchBy: options.search,
        sort_by: "id",
        sort_type: "DESC",
        page: options.page,
        per_page: options.perPage,
      },
      schema: CampaignsResponse,
      ...(signal ? { signal } : {}),
    });
    return res.campaigns;
  }

  async campaign(id: number, signal?: AbortSignal): Promise<Campaign> {
    try {
      return (
        await this.crm.get(`campaigns/${id}`, {
          schema: CampaignResponse,
          ...(signal ? { signal } : {}),
        })
      ).campaign;
    } catch (error) {
      if (error instanceof FluentSuiteError && (error.status === 404 || error.status === 422)) {
        throw new FluentSuiteError("not_found", `No campaign with id ${id}.`, {
          status: error.status,
          hint: "Call crm_campaign_overview without campaign_id to list campaigns.",
        });
      }
      throw error;
    }
  }

  /** Read-only campaign analytics. (GET campaigns/{id}/status is avoided: it changes campaign state.) */
  async campaignOverview(id: number, signal?: AbortSignal): Promise<OverviewStats> {
    return this.crm.get(`campaigns/${id}/overview_stats`, {
      schema: OverviewStats,
      ...(signal ? { signal } : {}),
    });
  }

  async campaignLinks(id: number, signal?: AbortSignal) {
    return (
      await this.crm.get(`campaigns/${id}/link-report`, {
        schema: LinkReport,
        ...(signal ? { signal } : {}),
      })
    ).links;
  }

  /** Email sequences (FluentCRM Pro). Throws a clear error when Pro is not installed. */
  async sequences(page: { page: number; perPage: number }, signal?: AbortSignal) {
    return this.pro(
      async () =>
        (
          await this.crm.get("sequences", {
            query: { with: ["stats"], page: page.page, per_page: page.perPage },
            schema: SequencesResponse,
            ...(signal ? { signal } : {}),
          })
        ).sequences,
    );
  }

  async sequence(id: number, signal?: AbortSignal) {
    return this.pro(async () => {
      try {
        return await this.crm.get(`sequences/${id}`, {
          query: { with: ["sequence_emails", "email_stats"] },
          schema: SequenceResponse,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (
          error instanceof FluentSuiteError &&
          !isMissingRoute(error) &&
          [404, 422].includes(error.status ?? 0)
        ) {
          throw new FluentSuiteError("not_found", `No sequence with id ${id}.`, {
            status: error.status,
          });
        }
        throw error;
      }
    });
  }

  async dashboardStats(signal?: AbortSignal) {
    return (
      await this.crm.get("reports/dashboard-stats", {
        schema: DashboardStats,
        ...(signal ? { signal } : {}),
      })
    ).stats;
  }

  /** A daily (or weekly/monthly for long ranges) time series: new contacts, emails sent, opens or clicks. */
  async series(
    kind: "subscribers" | "email-sents" | "email-opens" | "email-clicks",
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<Record<string, number>> {
    const res = await this.crm.get(`reports/${kind}`, {
      query: { date_range: [from, to] },
      schema: SeriesResponse,
      ...(signal ? { signal } : {}),
    });
    return res.data_sets?.[0]?.data ?? res.stats ?? {};
  }

  // ---- Writes. Only ever called from guardedWrite's execute step. -----------------------------

  /** Contact by email, or undefined (no error) when it does not exist. */
  async findByEmail(email: string, signal?: AbortSignal): Promise<Subscriber | undefined> {
    try {
      return await this.getContact({ email }, signal);
    } catch (error) {
      if (error instanceof FluentSuiteError && error.code === "not_found") return undefined;
      throw error;
    }
  }

  async createTag(title: string, signal?: AbortSignal): Promise<TagRow> {
    const res = await this.crm.post("tags", {
      body: { title },
      schema: z.looseObject({ item: TagRow }),
      ...(signal ? { signal } : {}),
    });
    return res.item;
  }

  async createList(title: string, signal?: AbortSignal): Promise<ListRow> {
    const res = await this.crm.post("lists", {
      body: { title },
      schema: z.looseObject({ item: ListRow }),
      ...(signal ? { signal } : {}),
    });
    return res.item;
  }

  /** Attach/detach tags or lists (by id) for many contacts. Chunked; never retried. */
  async syncSegments(
    type: "tags" | "lists",
    contactIds: number[],
    change: { attach: number[]; detach: number[] },
    signal?: AbortSignal,
  ): Promise<void> {
    for (let i = 0; i < contactIds.length; i += 100) {
      await this.crm.post("subscribers/sync-segments", {
        body: {
          type,
          subscribers: contactIds.slice(i, i + 100),
          attach: change.attach,
          detach: change.detach,
          find_by: "id",
        },
        ...(signal ? { signal } : {}),
      });
    }
  }

  /** Global status change for many contacts (fires FluentCRM's status-change hooks). */
  async setStatus(contactIds: number[], status: string, signal?: AbortSignal): Promise<void> {
    for (let i = 0; i < contactIds.length; i += 100) {
      await this.crm.put("subscribers/subscribers-property", {
        body: { property: "status", value: status, subscribers: contactIds.slice(i, i + 100) },
        ...(signal ? { signal } : {}),
      });
    }
  }

  /** Create a contact. Never sends a double opt-in email. */
  async createContact(fields: Record<string, unknown>, signal?: AbortSignal): Promise<Subscriber> {
    const res = await this.crm.post("subscribers", {
      body: { ...fields, double_optin: false },
      schema: z.looseObject({
        contact: Subscriber.partial({ tags: true, lists: true }).extend({ id: z.coerce.number() }),
      }),
      ...(signal ? { signal } : {}),
    });
    return { tags: [], lists: [], ...res.contact } as Subscriber;
  }

  async updateContact(
    id: number,
    fields: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.crm.put(`subscribers/${id}`, { body: fields, ...(signal ? { signal } : {}) });
  }

  async addNote(
    id: number,
    note: { title: string; description: string; type: string },
    signal?: AbortSignal,
  ): Promise<number> {
    const res = await this.crm.post(`subscribers/${id}/notes`, {
      body: { note },
      schema: z.looseObject({ note: z.looseObject({ id: z.coerce.number() }) }),
      ...(signal ? { signal } : {}),
    });
    return res.note.id;
  }

  /** How many subscribed contacts a list/tag recipient selection reaches (read-only, despite POST). */
  async estimateRecipients(selection: RecipientSelection, signal?: AbortSignal): Promise<number> {
    const res = await this.crm.post("campaigns/estimated-contacts", {
      body: selection,
      schema: z.looseObject({ count: z.coerce.number() }),
      ...(signal ? { signal } : {}),
    });
    return res.count;
  }

  /** Create a DRAFT campaign with content and recipients. Never schedules or sends. */
  async createDraftCampaign(
    draft: { title: string; subject: string; preHeader?: string | undefined; body: string },
    selection: RecipientSelection,
    signal?: AbortSignal,
  ): Promise<{ id: number; recipients: number }> {
    const opts = signal ? { signal } : {};
    const created = await this.crm.post("campaigns", {
      body: { title: draft.title },
      schema: z.looseObject({
        id: z.coerce.number(),
        settings: z.record(z.string(), z.unknown()).nullish(),
      }),
      ...opts,
    });
    await this.crm.put(`campaigns/${created.id}`, {
      body: {
        title: draft.title,
        email_subject: draft.subject,
        email_pre_header: draft.preHeader ?? "",
        email_body: draft.body,
        settings: { ...(created.settings ?? {}), ...selection },
      },
      ...opts,
    });
    const recipients = await this.crm.post(`campaigns/${created.id}/draft-recipients`, {
      body: selection,
      schema: z.looseObject({ count: z.coerce.number() }),
      ...opts,
    });
    return { id: created.id, recipients: recipients.count };
  }

  /** The recipient count FluentCRM would use for a campaign's saved selection. */
  async campaignRecipientEstimate(id: number, signal?: AbortSignal): Promise<number> {
    const res = await this.crm.get(`campaigns/${id}/estimated-recipients-count`, {
      schema: z.looseObject({ estimated_count: z.coerce.number() }),
      ...(signal ? { signal } : {}),
    });
    return res.estimated_count;
  }

  async campaignSample(id: number, size: number, signal?: AbortSignal): Promise<Subscriber[]> {
    const res = await this.crm.get(`campaigns/${id}/contacts-by-segment`, {
      query: { per_page: size, page: 1 },
      schema: ContactsResponse,
      ...(signal ? { signal } : {}),
    });
    return res.subscribers.data;
  }

  /**
   * Queue a draft campaign's recipients (FluentCRM's step 1 of sending; nothing is sent yet).
   * Returns how many recipients were queued.
   */
  async queueCampaignRecipients(
    id: number,
    selection: RecipientSelection,
    signal?: AbortSignal,
  ): Promise<number> {
    let total = 0;
    for (let page = 1; page <= 1000; page++) {
      const res = await this.crm.post(`campaigns/${id}/subscribe`, {
        body: { ...selection, page },
        schema: z.looseObject({
          has_more: z.boolean().nullish(),
          total_items: z.coerce.number().nullish(),
          count: z.coerce.number().nullish(),
        }),
        ...(signal ? { signal } : {}),
      });
      total = res.total_items ?? total + (res.count ?? 0);
      if (!res.has_more) return total;
    }
    throw new FluentSuiteError("upstream_error", "Queueing campaign recipients did not finish.");
  }

  /** SENDS (empty scheduledAt = now) or schedules a draft campaign. */
  async scheduleCampaign(
    id: number,
    scheduledAt: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const res = await this.crm.post(`campaigns/${id}/schedule`, {
      body: { scheduled_at: scheduledAt ?? "", sending_type: scheduledAt ? "schedule" : "instant" },
      schema: z.looseObject({ campaign: z.looseObject({ status: z.string() }) }),
      ...(signal ? { signal } : {}),
    });
    return res.campaign.status;
  }

  private async pro<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (isMissingRoute(error)) {
        throw new FluentSuiteError(
          "not_found",
          "Email sequences need FluentCRM Pro, which is not active on this site.",
          {
            status: 404,
          },
        );
      }
      throw error;
    }
  }
}
