# FluentCRM REST API reference (free core v2.9.84) for MCP tools and mock fixtures

Source: the FluentCRM plugin source (github.com/fluentcrm/fluent-crm, v2.9.84). Every `file:line` below is relative to the plugin root. Written by FluentSuite from reading the code; not official WPManageNinja documentation.
Routes: `app/Http/Routes/api.php` (written `api.php:N` below). Controllers: `app/Http/Controllers/*`.
The base URL is **`/wp-json/fluent-crm/v2/`** (`config/app.php:10-11`: `rest_namespace=fluent-crm`, `rest_version=v2`).

Conventions:
* `with[]`, `tags[]`, and similar array params go in the query string as `with[]=stats&with[]=custom_fields`. In a body they go as JSON arrays.
* Bodies can be JSON or form-encoded. `$request->get()` reads query and body merged.
* Integer path segments are enforced by `->int('id')`. A non-integer segment gives WP `rest_no_route` (404).

---

## 0. Cross-cutting behaviour

### 0.1 Auth
* The routes are standard WP REST routes. Use **WordPress Application Passwords over HTTP Basic**: `Authorization: Basic base64(user_login:app_password)`. FluentCRM's own "REST API keys" screen just creates a WP Application Password for a user who has FluentCRM access (`SettingsController.php:845-895`, which calls `WP_Application_Passwords::create_new_application_password`; the response contains `info.api_username` and `info.api_password`).
* Every route group has a Policy (`withPolicy(...)`). WP calls the policy as `permission_callback` (`vendor/wpfluent/framework/src/WPFluent/Http/Route.php:266`). The policy calls `PermissionManager::currentUserCan($perm)` (`app/Services/PermissionManager.php:250-271`):
  * A user with `manage_options` (an admin) always passes (the filter `fluentcrm_current_admin_can` defaults to true).
  * A non-admin passes only when **FluentCRM Pro is active** (`FLUENTCAMPAIGN` is defined) and the user holds the specific `fcrm_*` capability. Without Pro, only admins can use the API.
* The capability map, by policy:

| Group | Policy (file) | GET | write | delete / bulk |
|---|---|---|---|---|
| `subscribers` | SubscriberPolicy.php:22-28 | `fcrm_read_contacts` | `fcrm_manage_contacts` | `fcrm_manage_contacts_delete` (deleteSubscriber, deleteSubscribers, deleteNote). `deleteEmails` needs `fcrm_manage_email_delete`. Bulk action `add_to_email_sequence` needs `fcrm_manage_emails`; `add_to_automation` needs `fcrm_write_funnels`; `delete_contacts` needs `..._delete` (`:52-70`) |
| `tags`, `lists` | TagPolicy.php:22-40, ListPolicy.php | `fcrm_manage_contact_cats` (all methods) | same | `fcrm_manage_contact_cats_delete` (remove, do-bulk-action) |
| `campaigns` | CampaignPolicy.php:21-42 | `fcrm_read_emails` | `fcrm_manage_emails` | `fcrm_manage_email_delete` (delete, deleteCampaignEmails, do-bulk-action) |
| `reports` | ReportPolicy.php:22-34 | `fcrm_view_dashboard`. `reports/emails` GET needs `fcrm_read_emails` | - | `fcrm_manage_email_delete` |
| `funnels` | FunnelPolicy.php:21-41 | `fcrm_read_funnels` | `fcrm_write_funnels` | `fcrm_delete_funnels` |
| `companies` | CompanyPolicy.php:21-33 | needs the company module enabled **and** `fcrm_manage_contact_cats` | same | `..._delete` |

### 0.2 Success envelope
* The bodies are **not** wrapped in a `data` key. A controller returns a top-level JSON object, e.g. `{"subscribers": {...}}`.
* `sendSuccess()` adds `"__bench": <float seconds>` to every array response (`vendor/.../Response/Response.php:28-39`). If a controller returns a plain array, the router passes it through `sendSuccess` too, so it also gets `__bench` (`Route.php:220-237`). The only responses without `__bench` are the few that use `send()`: `GET lists`, `GET lists/{id}`, `GET tags/{id}`, `POST lists`, and `DELETE campaigns/{id}`. Mocks can include or omit `__bench` freely.

### 0.3 Error shapes. There are three kinds; mock all three.
1. **WP core errors**, from auth or permission failures or unknown routes. This is the standard `WP_Error` JSON:
   ```json
   {"code":"rest_forbidden","message":"Sorry, you are not allowed to do that.","data":{"status":401}}
   ```
   * The status is 401 when the request is unauthenticated and 403 when the user is logged in but lacks the capability.
   * Bad Basic credentials give `{"code":"incorrect_password"|"invalid_username", "message":"...","data":{"status":401}}`.
   * An unknown route gives `{"code":"rest_no_route","message":"No route was found matching the URL and request method.","data":{"status":404}}`.
2. **FluentCRM `sendError()`**. The body is the controller's array **verbatim**, usually just `{"message":"..."}`. The default HTTP status is **422** (`Response.php:41-48`). There is no `code` or `data.status`. Examples:
   ```json
   {"message":"Subscriber not found"}
   {"message":"Sorry contact already exist"}
   {"message":"Campaign status is not in draft status. Please reload the page"}
   ```
3. **Exceptions converted by the router** (`Route.php:240-262`):
   * Validation (`$this->validate`) gives HTTP **422**. The body is a field → rule → message map:
     ```json
     {"email":{"required":"The email field is required."}}
     {"email":{"unique":"Provided email already assigned to another subscriber."}}
     {"title":{"unique":"The title attribute is already taken and must be unique."}}
     ```
   * `findOrFail` miss gives HTTP **404** with `{"message":"No query results for model [FluentCrm\\App\\Models\\Subscriber]."}`.
   * Any other exception gives `{"message":"..."}` with the exception's code, or 423 if it has none.

### 0.4 Pagination (all `->paginate()` results)
* Query params are `page` (default 1, must be an int ≥ 1; `ComponentBinder.php:123-131`) and `per_page`. `per_page` is read from `$_REQUEST`, default **15** (`app/Models/Model.php:25-28`). There is no hard max in core.
* The JSON is the Laravel `LengthAwarePaginator::toArray` (`vendor/.../Pagination/LengthAwarePaginator.php:147-160`):
```json
{
  "total": 1243, "per_page": 15, "current_page": 2, "last_page": 83,
  "next_page_url": "https://example.com/wp-json/fluent-crm/v2/subscribers?page=3",
  "prev_page_url": "https://example.com/wp-json/fluent-crm/v2/subscribers?page=1",
  "from": 16, "to": 30,
  "data": [ ... ]
}
```
* An empty page has `"from": null, "to": null, "data": []`.
* Page URLs include only `page`, not the other filters.

Wrapper key per list endpoint:

| Endpoint | Shape |
|---|---|
| GET subscribers | `{"subscribers": <paginator>, "custom": <custom_fields param or null>}` |
| GET subscribers/{id}/notes | `{"notes": <paginator>, "fields": {"fields": [...]}}` |
| GET subscribers/{id}/emails | `{"emails": <paginator>}` |
| GET subscribers/{id}/url-metrics | `{"urlMetrics": <paginator with data=[{url,count}]>}` |
| GET subscribers/{id}/tracking-events | `{"events": <paginator>}` |
| GET tags | `{"tags": <paginator>, "all_tags"?: [...]}` |
| GET lists | **No paginator**: `{"lists": [..items..], "pagination": {"total": N}, "all_lists"?: [...]}` |
| GET campaigns | `{"campaigns": <paginator>}` |
| GET campaigns/{id}/emails | `{"emails": <paginator>, "failed_counts": N}` |
| GET campaigns/{id}/unsubscribers | `{"unsubscribes": <paginator>}` |
| GET campaigns/{id}/contacts-by-segment | `{"subscribers": <paginator>}` |
| GET reports/emails | `{"emails": <paginator>, "statuses": {...} or null}` |
| GET funnels | `{"funnels": <paginator>}` |
| GET companies | `{"companies": <paginator>}` |
| GET sequences (Pro) | `{"sequences": <paginator>}` |

### 0.5 Enumerations
* Contact `status` (`app/Functions/helpers.php:480-490`): `subscribed, pending, unsubscribed, transactional, bounced, complained, spammed`. You can't set `bounced`, `complained`, or `spammed` from the UI (`:521-527`).
* `contact_type` (`helpers.php:582-587`): `lead`, `customer`.
* Campaign `status` values seen in code: `draft, pending-scheduled, processing, scheduled, working, paused, archived`.
* Campaign email (`fc_campaign_emails.status`): `draft, pending, scheduled, processing, sent, paused, failed, bounced`.

---

## 1. Contacts (`/subscribers`, SubscriberPolicy)

### 1.0 Subscriber object
Columns come from `database/migrations/Subscribers.php:25-54`. `$appends = ['full_name','photo']` (`app/Models/Subscriber.php:28`). `hash` is `md5(email)`, set on every save (`Subscriber.php:70-72`). Timestamps use the format `"Y-m-d H:i:s"` in site-local time.
```json
{
  "id": 1532, "user_id": null, "hash": "5d41402abc4b2a76b9719d911017c592",
  "contact_owner": null, "company_id": null,
  "prefix": "Ms", "first_name": "Jane", "last_name": "Doe", "email": "jane@example.com",
  "timezone": null, "address_line_1": "12 Main St", "address_line_2": null,
  "postal_code": "94107", "city": "San Francisco", "state": "CA", "country": "US",
  "ip": "203.0.113.7", "latitude": null, "longitude": null,
  "total_points": 0, "life_time_value": 0, "phone": "+1 415 555 0100",
  "status": "subscribed", "contact_type": "lead", "source": "web",
  "avatar": null, "date_of_birth": "1990-04-12",
  "created_at": "2026-09-14 10:22:05", "last_activity": "2026-10-09 18:01:44",
  "updated_at": "2026-10-09 18:01:44",
  "full_name": "Jane Doe",
  "photo": "https://www.gravatar.com/avatar/5d41...?s=128&d=...Jane+Doe",
  "tags":  [{"id": 3, "title": "VIP", "slug": "vip", "description": null,
             "created_at": "2026-01-02 09:00:00", "updated_at": "2026-01-02 09:00:00",
             "pivot": {"subscriber_id": 1532, "object_id": 3,
                       "object_type": "FluentCrm\\App\\Models\\Tag",
                       "created_at": "2026-09-14 10:22:05", "updated_at": "2026-09-14 10:22:05"}}],
  "lists": [{"id": 1, "title": "Newsletter", "slug": "newsletter", "description": "",
             "is_public": 0, "created_at": "...", "updated_at": "...",
             "pivot": {"subscriber_id": 1532, "object_id": 1,
                       "object_type": "FluentCrm\\App\\Models\\Lists",
                       "created_at": "...", "updated_at": "..."}}]
}
```
* The `tags` and `lists` relations sort by `title` ASC (`Subscriber.php:323-337`, `:496-512`).
* When the company module is enabled, list and show responses also eager-load `company` (object or null) and `companies` (array).

### 1.1 List / search contacts
**GET `subscribers`** (`api.php:47`, `SubscriberController::index` `SubscriberController.php:35-81`; query builder `app/Services/ContactsQuery.php:14-120`)

| Param | Notes |
|---|---|
| `search` | Uses LIKE `%s%` on `email, first_name, last_name, address_line_1, address_line_2, postal_code, city, state, country, phone, status`. A two-word value also matches first OR last name (`Subscriber.php:139-176`). |
| `page`, `per_page` | See 0.4. |
| `sort_by` | Default `id`. Ignored unless it is `id` or a fillable column (`ContactsQuery.php:49-53`). |
| `sort_type` | `DESC` (default) or `ASC`. |
| `filter_type` | `simple` (default) or `advanced`. |
| `tags[]` | Tag **IDs**. A contact matches if it has ANY of them (`Subscriber.php:214-232`). Simple mode only. |
| `lists[]` | List IDs, matched as ANY. Simple mode only. |
| `statuses[]` | Intersected with the valid statuses. Simple mode only. |
| `company_ids[]` | Filters by company. |
| `custom_fields` | When `"true"`, search also covers custom-field values and each row gains `custom_fields: {slug: value}`. |
| `has_commerce` | Truthy eager-loads `commerce_by_provider`. This needs an e-commerce integration. |
| `advanced_filters` | JSON string used when `filter_type=advanced`: an array of OR-groups, each an array of AND-items `{"source":["subscriber","email"],"operator":"contains","value":"@acme.com"}` (`ContactsQuery.php:159-196`). The providers are hook-based. Recommend tools stay on simple mode. |

Response:
```json
{"subscribers": {"total": 2, "per_page": 15, "current_page": 1, "last_page": 1,
  "next_page_url": null, "prev_page_url": null, "from": 1, "to": 2,
  "data": [ <Subscriber with tags[], lists[]>, ... ]},
 "custom": null, "__bench": 0.041}
```

**GET `subscribers/search-contacts`** is a lightweight typeahead (`api.php:76`, `SubscriberController.php:1553-1595`).
* Params: `search`, `limit` (default 20), and `values[]` (ids to always include).
* The response is an **object keyed by id**. The ids are strings.
```json
{"contacts": {"1532": {"first_name":"Jane","last_name":"Doe","full_name":"Jane Doe","email":"jane@example.com","id":"1532"}}}
```

### 1.2 Get one contact
**GET `subscribers/{id}`** (`api.php:55`, `SubscriberController::show` `:87-177`)
* The default eager-load is `tags`, `lists`, and `companies` when the company module is on.
* `with[]` options:
  * `stats` adds `subscriber.stats = {"emails": n, "opens": n, "clicks": n}`. These count sent campaign emails (`Subscriber.php:676-693`).
  * `subscriber.custom_values` adds `subscriber.custom_values = {"<field_slug>": "value", ...}`, or `{}` when there are none.
  * `custom_fields` adds a top-level `custom_fields`: the custom-field **definitions** (option `contact_custom_fields`), e.g. `[{"slug":"plan","label":"Plan","type":"select-one","options":["Free","Pro"],"group":"Default"}]`.
  * `commerce_stat` adds `subscriber.commerce_stat`. It is provider-dependent and `[]` without an e-commerce integration.
* Fields that are always conditional:
  * `user_edit_url` and `user_roles[]` appear when the contact is linked to a WP user.
  * `unsubscribe_reason` and `unsubscribe_date` appear when `status` is `unsubscribed`, `bounced`, or `complained`.
  * `date_of_birth` `"0000-00-00"` is returned as `""`.
* If the contact isn't found, the response is `{"message":"Subscriber not found"}` with **422** (not 404).
```json
{"subscriber": { <Subscriber>, "stats": {"emails": 12, "opens": 7, "clicks": 2},
                 "custom_values": {"plan": "Pro"} },
 "custom_fields": [ ... only if with[]=custom_fields ... ], "__bench": 0.02}
```

**Lookup by email.** `show()` checks `get_by_email` only when `id` is falsy (`:100-104`). Use **GET `subscribers/0?get_by_email=jane@example.com&with[]=stats`**. This returns the same shape as above, or the 422 `"Subscriber not found"` error. The alternative is `GET subscribers?search=<email>`, which is a fuzzy LIKE match, so filter for exact `email` on the client.

### 1.3 Create
**POST `subscribers`** (`api.php:48`, `SubscriberController::store` `:319-394`)
* Body: `email` (required, validated as email and unique), `status` (required), and any fillable field (`first_name, last_name, prefix, phone, address_line_1, address_line_2, city, state, postal_code, country, timezone, date_of_birth, source, contact_type, company_id, avatar, ...`; `Subscriber.php:35-63`).
* Optional: `tags[]` and `lists[]` (IDs), `custom_values` {slug: value}, `double_optin` (bool; it sends the opt-in email, use with `status=pending`), and `__force_update: "yes"` (upsert an existing email instead of failing).
* `user_id` is auto-linked when a WP user has that email.
```json
{"message":"Successfully added the subscriber.","contact":{ <Subscriber, no relations loaded> },"action_type":"created","__bench":0.05}
```
* With `__force_update=yes` on an existing email, the same shape comes back with `"action_type":"updated"`.
* A duplicate without force gives 422 `{"email":{"unique":"Provided email already assigned to another subscriber."}}`.

**POST `subscribers/bulk-add-update`** (`api.php:83`, `:396-447`)
* Body: `contacts` (a JSON array of contact objects, each may carry `tags` and `lists`), `force_update` (bool), and `double_optin` (bool).
* Response: `{"message":"...","created":[{"id","email","status"}],"updated":[...],"invalids":[...]}`.

### 1.4 Update
**PUT `subscribers/{id}`** (`api.php:58`, `SubscriberController::updateSubscriber` `:449-578`)
* The body is either `{"subscriber": {...}}` (a JSON string or object) or flat fields.
* `email`, if sent, is validated as unique, excluding this contact.
* Supported keys: any fillable field, `custom_values` {slug: value} (this syncs the values and deletes other custom values), `attach_tags[]`, `detach_tags[]`, `attach_lists[]`, `detach_lists[]` (IDs).
* `created_at` and `last_activity` are ignored.
* Setting `status` here saves it directly and fires `fluent_crm/contact_updated`. It does not fire the status-change hooks. For a proper status change, use 1.6.
```json
{"message":"Subscriber successfully updated","contact":{ <Subscriber> },"isDirty":true,"values":{"plan":"Pro"},"__bench":0.03}
```

### 1.5 Add/remove tags and lists. There are 3 endpoints.

**(a) POST `subscribers/sync-segments`**, the "tagger" (`api.php:51`, `:279-317`). It identifies tags and lists by **slug by default**.

| Field | Notes |
|---|---|
| `type` | `"tags"` or `"lists"`. Anything other than `tags` is treated as lists. |
| `subscribers` | Array of contact ids. |
| `attach` | Array of tag/list identifiers to add. |
| `detach` | Array of identifiers to remove. |
| `find_by` | `slug` (default) or `id`, the column used to resolve `attach`/`detach` (`:568-583`). |

Request and response:
```json
{"type":"tags","subscribers":[1532,1533],"attach":["vip"],"detach":["cold-lead"],"find_by":"slug"}
→ {"message":"Successfully updated the subscribers.","subscribers":[ <Subscriber with tags,lists> ...]}
```

**(b) POST `subscribers/do-bulk-action`** (`api.php:52`, `:1043-1475`). It uses IDs and supports "all matching a filter".

| Field | Notes |
|---|---|
| `action_name` | `add_to_tags`, `remove_from_tags`, `add_to_lists`, `remove_from_lists`, `change_contact_status`, `change_contact_type`, `delete_contacts`, `send_double_optin`, `add_to_company`, `remove_from_company`, `update_custom_fields`, `add_to_email_sequence` (Pro), `add_to_automation` (Pro). |
| `subscriber_ids` | Array of ids. |
| `action_options` | Array of tag/list **IDs**. Required for the 4 tag/list actions (`:1449-1463`). |
| `new_status` | The value for the change_* actions; the company id, sequence id, or funnel id for the others. |
| `custom_field` | `{"key":"plan","value":"Pro"}` for `update_custom_fields`. |
| `is_all` | `"yes"` processes contacts matching `contact_query` (`{filter_type, search, tags, lists, statuses, company_ids, advanced_filters}`) in chunks of 400 by `id > last_id`. Re-call with `last_id` until the response has `is_completed: true`. |

Request and response:
```json
{"action_name":"add_to_tags","subscriber_ids":[1532,1533],"action_options":[3,7]}
→ {"last_contact_id":1533,"completed_contacts":2,"message":"Selected bulk action has been successfully completed"}
```
* Errors come back as 422 with a `message`: `"Subscribers selection is required"`, `"Please provide bulk options"`, `"Selected Action is not valid"`, or `"This action requires FluentCRM Pro"`.

**(c) PUT `subscribers/{id}`** with `attach_tags` and related keys handles a single contact (1.4).

### 1.6 Status change (subscribe/unsubscribe)
* **PUT `subscribers/subscribers-property`** (`api.php:49`, `:179-247`)
  * Body: `{"property":"status","value":"unsubscribed","subscribers":[1532]}`.
  * Valid properties are `status`, `contact_type`, `avatar`, and `company_id`. The value is checked against the enum.
  * It fires `fluent_crm/subscriber_status_changed`.
  * Response: `{"message":"Subscribers successfully updated"}`.
  * An invalid value gives 422 `{"message":"Value is not valid"}`. An invalid property gives `{"message":"Column is not valid"}`.
* Or use `do-bulk-action` with `action_name=change_contact_status` and `new_status=subscribed|unsubscribed|...` (`:1258-1278`, which calls `Subscriber::updateStatus` `Subscriber.php:2417-2434`).
* **POST `subscribers/{id}/send-double-optin`** (`api.php:66`, `:923-938`) sends an email and returns `{"message":"Double OptIn email has been sent"}`. **Guard this.**

### 1.7 Notes
* **GET `subscribers/{id}/notes`** (`api.php:68`, `:699-724`). Params: `search` (matches title), `page`, `per_page`. Columns: `database/migrations/SubscriberNotes.php:25-35`.
```json
{"notes":{"total":1,"per_page":15,"current_page":1,"last_page":1,"next_page_url":null,"prev_page_url":null,"from":1,"to":1,
  "data":[{"id":88,"subscriber_id":1532,"parent_id":null,"created_by":1,"status":"open","type":"note","is_private":1,
           "title":"Call recap","description":"<p>Asked about Pro pricing</p>",
           "created_at":"2026-10-01 14:00:00","updated_at":"2026-10-01 14:00:00",
           "added_by":{"ID":1,"first_name":"Admin","last_name":"","display_name":"admin"}}]},
 "fields":{"fields":[ ...note type options... ]}}
```
* `added_by` is `false` when `created_by` is null (`app/Models/SubscriberNote.php:71-85`).
* **POST `subscribers/{id}/notes`** (`api.php:69`, `:726-770`)
  * Body: `{"note":{"title":"..","description":"..","type":"note","created_at":"optional Y-m-d H:i:s"}}`. `title`, `description`, and `type` are all required.
  * `type` is free text. The UI uses `note, call, email, meeting, quote_sent, activity, ...`.
  * Response: `{"note":{...},"message":"Note successfully added"}`.
* **PUT `subscribers/{id}/notes/{note_id}`** (`api.php:70`) takes the same body and returns `{"note":{...},"message":"Note successfully updated"}`.
* **DELETE `subscribers/{id}/notes/{note_id}`** (`api.php:71`) needs the `_delete` cap and returns `{"message":"Note successfully deleted"}`.

### 1.8 Emails, activity, purchase history
* **GET `subscribers/{id}/emails`** (`api.php:59`, `:617-681`)
  * Params: `filter` = `open|click|unopened`, `page`, `per_page`.
  * Rows are `fc_campaign_emails` rows (`database/migrations/CampaignEmails.php:25-42`), newest first.
```json
{"emails":{"total":12,"per_page":15,"current_page":1,"last_page":1,"next_page_url":null,"prev_page_url":null,"from":1,"to":12,
  "data":[{"id":90211,"campaign_id":41,"email_type":"campaign","subscriber_id":1532,"email_subject_id":null,
           "email_address":"jane@example.com","email_subject":"October product update","email_body":"<html>...</html>",
           "email_headers":null,"is_open":1,"is_parsed":1,"click_counter":2,"status":"sent","note":null,
           "scheduled_at":"2026-10-05 09:00:00","email_hash":"a1b2c3...","created_at":"2026-10-05 08:59:12","updated_at":"2026-10-05 09:00:31"}]}}
```
* **POST `subscribers/{id}/emails/send`** (`api.php:61`, `:949-984`) **sends a one-off email**. **Guard this.**
  * Body: `{"campaign":{"email_subject":"..","email_body":"..", ...}}`.
  * It needs the contact `status` to be `subscribed` or `transactional`.
* **DELETE `subscribers/{id}/emails`** takes body `email_ids[]`.
* **GET `subscribers/{id}/url-metrics`** (`api.php:81`, `:1709-1737`) returns `{"urlMetrics": <paginator, data=[{"url":"https://..","count":3}]>}`.
* **GET `subscribers/{id}/purchase-history?provider=woo|edd|...`** (`api.php:63`, `PurchaseHistoryController.php:27-55`) returns `{"orders":{"orders":[],"total":0}}`. Integrations fill this through the `fluent_crm/purchase_history_{provider}` filter, so without an integration it is always empty.
* **GET `subscribers/{id}/form-submissions?provider=`** returns `{"submissions":{"data":[],"total":0}}`. **GET `subscribers/{id}/support-tickets?provider=`** returns `{"tickets":{"data":[],"total":0,"columns_config":{...}}}`. Both are filter-driven (`:842-921`).
* **GET `subscribers/{id}/tracking-events`** (`:1665-1682`) returns `{"events": <paginator>}`, or 422 `{"message":"Event Tracker is not enabled","error_code":"not_enabled"}`.
* **GET `funnels/subscriber/{subscriber_id}/automations`** (`api.php:170`) lists the contact's automations.
* There is no generic "activity timeline" endpoint in core. `info-widgets` (`:1596-1663`) returns provider widgets.

### 1.9 Delete
* **DELETE `subscribers/{id}`** (`api.php:56`, `:249-258`) returns `{"message":"Selected Subscriber has been deleted successfully"}`, or 404 if the id is unknown.
* **DELETE `subscribers`** with body `{"subscribers":[ids]}` (`api.php:50`, `:260-277`) returns `{"message":"Selected Subscribers has been deleted"}`.
* Both need `fcrm_manage_contacts_delete`.

---

## 2. Tags and lists

### 2.1 Tags (`/tags`, TagPolicy)
Object columns (`database/migrations/Tags.php:22-27`): `id, title, slug, description, created_at, updated_at`.

**GET `tags`** (`api.php:13`, `TagsController.php:26-62`)
* Params: `search`, `sort_by` (default `id`), `sort_order` (`DESC`; note the name is **not** `sort_type`), `page`, `per_page`, `exclude_counts` (truthy skips the per-row count), `all_tags` (truthy adds a flat list).
* Each row gets `subscribersCount`, the number of `subscribed` contacts with that tag.
```json
{"tags":{"total":2,"per_page":15,"current_page":1,"last_page":1,"next_page_url":null,"prev_page_url":null,"from":1,"to":2,
  "data":[{"id":7,"title":"Webinar Attendee","slug":"webinar-attendee","description":"","created_at":"2026-08-01 12:00:00","updated_at":"2026-08-01 12:00:00","subscribersCount":214},
          {"id":3,"title":"VIP","slug":"vip","description":null,"created_at":"...","updated_at":"...","subscribersCount":38}]},
 "all_tags":[{"id":"7","title":"Webinar Attendee","slug":"webinar-attendee"},{"id":"3","title":"VIP","slug":"vip"}]}
```
* The ids in `all_tags` are **strings**.

**GET `tags/{id}`** (`api.php:16`, `:66-71`) returns `{"tag":{...}}`, or `{"tag":null}` if the id is missing.

**POST `tags`** (`api.php:14`, `:78-108`)
* Body: `title` (required), `slug` (optional; auto-slugified and must be unique), `description`.
* Response: `{"lists":{tag},"item":{tag},"message":"Successfully saved the tag."}`. The odd `lists` key mirrors `item`.
* A duplicate slug gives 422 `{"slug":{"unique":"The slug attribute is already taken and must be unique."}}`.

**Other tag routes:**
* **PUT `tags/{id}`** (`:116`) takes `title` (required), `slug`, and `description`. With `id=0` plus `update_by=slug`, it updates by slug.
* **POST `tags/bulk`** (`:167-207`) takes `{"tags":[{"title","slug"?}]}`, upserts by slug, and returns `{"message","ids":[...]}`.
* **DELETE `tags/{id}`** and **POST `tags/do-bulk-action`** (`{"tagIds":[..]}`) need the delete cap.

### 2.2 Lists (`/lists`, ListPolicy)
Object columns (`database/migrations/Lists.php:23-29`): `id, title, slug, description, is_public, created_at, updated_at`.

**GET `lists`** (`api.php:30`, `ListsController.php:28-70`)
* Params: `search`, `sort_by`, `sort_order`, `page`, `per_page`, `exclude_counts`, `all_lists`.
* **This endpoint does not return a paginator object.** It returns the items array plus `pagination.total` only.
* Each row has `totalCount` (all contacts) and `subscribersCount` (subscribed contacts).
```json
{"lists":[{"id":1,"title":"Newsletter","slug":"newsletter","description":"Monthly news","is_public":0,
           "created_at":"2026-01-02 09:00:00","updated_at":"2026-01-02 09:00:00","totalCount":1320,"subscribersCount":1187}],
 "pagination":{"total":1},
 "all_lists":[{"id":"1","title":"Newsletter","slug":"newsletter"}]}
```

**Other list routes:**
* **GET `lists/{id}`** (`:78-81`) returns the **bare** list object (no wrapper), or `null`.
* **POST `lists`** (`:90-121`) takes `title` (required), `slug` (defaults from the title; must be unique), and `description`. It returns `{"lists":{list},"item":{list},"message":"Successfully saved the list."}`.
* **PUT `lists/{id}`**, **POST `lists/bulk`**, **DELETE `lists/{id}`**, and **POST `lists/do-bulk-action`** mirror the tag routes.

---

## 3. Campaigns (`/campaigns`, CampaignPolicy)

### 3.0 Campaign object
Columns: `database/migrations/Campaigns.php:22-46`. The default `settings` come from `app/Models/Campaign.php:27-66`. `settings` is unserialized PHP into JSON. `recipients_count` is cast to int.
```json
{"id":41,"parent_id":null,"type":"campaign","title":"October Product Update","available_urls":null,
 "slug":"october-product-update","status":"archived","template_id":null,
 "email_subject":"What's new in October","email_pre_header":"3 new features",
 "email_body":"<!-- wp:paragraph --><p>Hi {{contact.first_name}}...</p>","recipients_count":1187,
 "delay":0,"utm_status":0,"utm_source":null,"utm_medium":null,"utm_campaign":null,"utm_term":null,"utm_content":null,
 "design_template":"simple","scheduled_at":"2026-10-05 09:00:00",
 "settings":{"mailer_settings":{"from_name":"","from_email":"","reply_to_name":"","reply_to_email":"","is_custom":"no"},
             "subscribers":[{"list":"1","tag":"all"}],
             "excludedSubscribers":[{"list":null,"tag":null}],
             "sending_filter":"list_tag","dynamic_segment":{"id":"","slug":""},"advanced_filters":[[]],
             "template_config":{ ... },"sending_type":"instant","is_transactional":"no"},
 "created_by":1,"created_at":"2026-10-03 11:00:00","updated_at":"2026-10-05 09:40:00"}
```
The model has a global scope `type='campaign'` (`Campaign.php:68-70`). Recurring campaigns, sequences, and custom emails are separate types.

### 3.1 List
**GET `campaigns`** (`api.php:89`, `CampaignController::campaigns` `CampaignController.php:32-66`)
* Params:
  * `searchBy` (title LIKE; **not** `search`)
  * `statuses[]`
  * `sort_by` (default `id`), `sort_type` (`ASC` or `DESC`)
  * `labels[]` (label term ids)
  * `with[]=stats`
  * `page`, `per_page`
* With `with[]=stats`, each row gets:
  * `stats = {"total","sent","clicks","views","unsubscribers","revenue"?}` (`Campaign.php:651-697`)
  * `next_step` (the wizard step meta, `""`, or `"1"`/`"2"`/`"3"`)
  * `labels` (array).
```json
{"campaigns":{"total":9,"per_page":15,"current_page":1,"last_page":1,"next_page_url":null,"prev_page_url":null,"from":1,"to":9,
  "data":[{ <Campaign>, "stats":{"total":1187,"sent":1187,"clicks":96,"views":512,"unsubscribers":4},
            "next_step":"3","labels":[{"id":2,"slug":"product","title":"Product","color":"#409EFF"}] }]}}
```

### 3.2 Get one
**GET `campaigns/{id}`** (`api.php:98`, `:87-120`)
* Optional `with[]` takes relations, e.g. `subjects` or `template`.
* Returns `{"campaign":{ <Campaign>, "server_time":"2026-10-11 08:00:00" },"templates":[{"ID":12,"post_title":"Branded"}]}`.
* With `?viewCampaign=1`, it instead returns `{"campaign":{...},"emails":<paginator of emails with subscriber>}`.

**GET `campaigns/{id}/emails`** (`api.php:114`, `:122-155`)
* Params: `filter_type` = `click|view|unopened|failed`, `search` (searches the subscriber), `page`, `per_page`.
* Returns `{"emails":<paginator of campaign-email rows each with "subscriber":{...}>,"failed_counts":0}`.

### 3.3 Stats and reports (read-only unless noted)

**GET `campaigns/{id}/overview_stats`** (`api.php:124`, `:1231-1263`) is **pure read**. Prefer it for reports.
```json
{"sent_count":1187,
 "stat":[{"status":"sent","total":1185},{"status":"failed","total":2}],
 "analytics":{
   "open":{"total":512,"label":"Open Rate (512)","type":"open","is_percent":true,"icon_class":"dashicons dashicons-buddicons-pm"},
   "click":{"total":96,"label":"Click Rate (96)","type":"click","is_percent":true,"icon_class":"el-icon el-icon-position"},
   "ctor":{"total":"18.75%","label":"Click To Open Rate","type":"ctor","icon_class":"el-icon el-icon-chat-dot-square"},
   "unsubscribe":{"total":4,"label":"Unsubscribe (4)","type":"unsubscribe","is_percent":true,"icon_class":"el-icon el-icon-warning-outline"},
   "revenue":{"label":"Revenue (USD)","type":"revenue","total":"1,240.00","icon_class":"el-icon el-icon-money"}}}
```
* The analytics keys appear only when non-zero (`app/Models/CampaignUrlMetric.php:104-183`). `open` counts opens plus clicks, capped at `sent_count`.

**GET `campaigns/{id}/status`** (`api.php:123`, `:1093-1229`) is the polling endpoint the UI uses.
* It returns `{"current_timestamp","stat","campaign":{...,"sent_by":{...}},"sent_count","analytics","subject_analytics"}`. `analytics` is filled only when the campaign is `archived`.
* **It has side effects**: it may flip `scheduled` to `working` to `archived`, reset stuck emails, and kick the sending cron. Avoid it in read-only tools.

**GET `campaigns/{id}/link-report`** (`api.php:125`, `CampaignAnalyticsController.php:21-26`) returns `{"links":[{"total":42,"url":"https://example.com/pricing","id":311}]}`.

**GET `campaigns/{id}/unsubscribers`** (`api.php:128`, `CampaignAnalyticsController.php:255-269`) returns `{"unsubscribes": <paginator of url-metric rows {id,campaign_id,subscriber_id,type:"unsubscribe",...,"subscriber":{...,"reason":"..."}}>}`.

**GET `campaigns/{id}/revenues`** (`:126`) only works with WooCommerce or EDD.

**GET `campaigns/{id}/estimated-recipients-count`** (`api.php:112`, `:300-318`) returns `{"estimated_count":1187}`.

**GET `campaigns/{id}/contacts-by-segment`** (`api.php:130`, `CampaignAnalyticsController.php:271-292`) returns `{"subscribers":<paginator>}` of the targeted contacts. Params: `search`, `sort_by`, `sort_type`.

### 3.4 Create and draft
* **POST `campaigns`** (`api.php:90`, `:68-85`)
  * The only body field is **`title`** (required, unique among campaigns).
  * It creates status `draft` with the default settings and returns the **bare campaign object** (no wrapper), with `template` and `subjects` loaded: `{ <Campaign>, "template": null, "subjects": [] }`.
* **PUT `campaigns/{id}`** (`api.php:99`, `:163-229`) fills in the draft.
  * Body: `title` (required, unique), `slug`, `template_id`, `email_subject`, `email_pre_header`, `email_body`, `utm_status`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `scheduled_at`, `design_template`, `settings` (whole object).
  * Optional: `update_subjects` + `subjects[{key,value,id?}]` (A/B subjects), and `next_step` (1 or 2).
  * `next_step=2` enforces compliance: when the footer is disabled or the visual builder is used, the body must contain `##crm.unsubscribe_url##`, `##crm.manage_subscription_url##`, or `{{crm_global_email_footer}}`. Otherwise the response is a 422 with `{"compliance_failed":true,"message":...}`.
  * Response: `{"campaign":{...}}`.
* **POST `campaigns/{id}/draft-recipients`** (`api.php:111`, `:264-298`) saves the recipient selection only and does not send.
  * Recipient selection fields (shared by `draft-recipients`, `subscribe`, and `estimated-contacts`):

    | Field | Notes |
    |---|---|
    | `sending_filter` | `list_tag` (default), `dynamic_segment` (Pro), or `advanced_filters`. |
    | `subscribers` | Include rows `[{"list":"<list id or 'all'>","tag":"<tag id or 'all'>"}]`. Each row is list AND tag; the rows are OR'd. |
    | `excludedSubscribers` | Exclude rows `[{"list":id or null,"tag":id or null}]`. |
    | `dynamic_segment` | `{"id":..,"slug":..}`. |
    | `advanced_filters` | JSON string. Same format as contacts. |
  * Response: `{"message":"Recipient settings has been updated","count":1187}`.
  * When nothing matches, the response is 422 `{"message":"Sorry no subscribers found based on your selection"}`.
* **POST `campaigns/estimated-contacts`** (`api.php:95`, `:415-443`) takes the same fields and returns `{"count":1187,"execution_time":0.12}`. It is read-only despite using POST.

### 3.5 Send and schedule endpoints. **Guard all of these.**

| Endpoint | Effect | file:line |
|---|---|---|
| POST `campaigns/{id}/subscribe` | Materialises recipients into `fc_campaign_emails` in pages (`page` param; response `has_more, count, total_items, page_total, next_page`). Takes the selection fields above. Step 1 of sending. | api.php:110, CampaignController.php:320-413 |
| POST `campaigns/{id}/schedule` | **Sends or schedules.** Body: `scheduled_at` (empty means send **now**; status becomes `processing` and the send fires). A `"Y-m-d H:i:s"` value means scheduled (`pending-scheduled`). `sending_type`=`schedule` or `range_schedule`; the range form takes `scheduled_at` as a 2-element array. The campaign must be `draft`, otherwise 422. Response `{"campaign","message","current_timestamp"}`. | api.php:116, :469-595 |
| GET `campaigns/{id}/processing-stat` | **A GET that sends emails**: it runs `CampaignProcessor->processEmails()`. | api.php:118, :597-641 |
| GET `campaigns/{id}/status` | Mutates status, see 3.3. | api.php:123 |
| POST `campaigns/{id}/pause` | Needs status `working`. Sets `paused`. | api.php:102, :1265-1290 |
| POST `campaigns/{id}/resume` | Needs status `paused`. Sets `working` and re-queues emails. | api.php:104, :1292-1316 |
| POST `campaigns/{id}/un-schedule` | From `scheduled`/`pending-scheduled`/not-yet-started `processing` back to `draft`. Deletes queued emails. | api.php:117, :1381-1420 |
| PUT `campaigns/{id}/title` | Renames. When `scheduled`, `scheduled_at` here **reschedules**. | api.php:105, :1318-1342 |
| POST `campaigns/send-test-email` | Sends a test email. | api.php:91, :643 |
| POST `campaigns/{id}/duplicate` | Creates a new draft `[Duplicate] ...`. Returns `{"campaign","message"}`. Safe. | api.php:103, :1344-1379 |
| DELETE `campaigns/{id}` | Returns `{"success":true}`. | api.php:106, :993-1002 |
| POST `campaigns/do-bulk-action` | `action_name`=`delete_campaigns` or `apply_labels`, with `campaign_ids[]` and `labels`. | api.php:108, :1004-1058 |
| DELETE `campaigns/{id}/emails` | Body `email_ids[]`. | api.php:115, :446 |

---

## 4. Email sequences (**Pro only**; FluentCampaign Pro)
These routes are **not registered by the free plugin** (there is no `sequences` group in `api.php`). The paths and fields below come from the bundled admin UI that calls them (`resources/admin/Modules/Email/EmailSequences/*.vue`). On a free-only site, every call returns `rest_no_route` 404.

| Call | Evidence | Response shape used by the UI |
|---|---|---|
| GET `sequences?page&per_page&search&with[]=stats&order&orderBy` | AllSequences.vue:253-282 | `{"sequences": <paginator>}`. The rows are campaign-like objects (`type:"email_sequence"`, `id,title,status,settings,created_at`) plus `stats:{"emails":n,"subscribers":n,"revenue"?:{"currency","amount"}}` (`AllSequences.vue:80-98`) |
| GET `sequences/{id}?with[]=sequence_emails&with[]=email_stats` | ViewSequence.vue:245-256 | `{"sequence":{...,"settings":{"mailer_settings":{...}}},"sequence_emails":[{id,title,email_subject,delay,settings,"stats":{"sent","views","clicks"}}]}` (ViewSequence.vue:115-134) |
| GET `sequences/{id}/subscribers?page&per_page` | _SequenceSubscribers.vue:125-137 | A **bare paginator**. Rows are `{id,subscriber_id,status,notes,created_at,next_execution_time,"subscriber":{full_name,email,photo}}` |
| GET `sequences/subscriber/{contact_id}/sequences` | admin UI | The sequences a contact is enrolled in |
| POST `sequences`, PUT `sequences/{id}`, POST `sequences/{id}/duplicate`, DELETE `sequences/{id}`, POST/DELETE `sequences/{id}/subscribers`, POST `sequences/do-bulk-action` | admin UI | Writes. POST `sequences/{id}/subscribers` **enrolls contacts, which starts sending**. |

Core also has a Pro-gated enroll path: `subscribers/do-bulk-action` with `action_name=add_to_email_sequence` and `new_status=<sequence id>`. It enrolls only `subscribed` contacts who aren't already in the sequence (`SubscriberController.php:1138-1180`).

---

## 5. Dashboard and reports (`/reports`, ReportPolicy → `fcrm_view_dashboard`)

**GET `reports/dashboard-stats`** (`api.php:210`, `DashboardController.php:21-101`; counts in `app/Services/Stats.php:14-83`)
```json
{"stats":{
   "total_subscribers":{"title":"Active Contacts","count":1187,"route":{"name":"subscribers"}},
   "total_campaigns":{"title":"Campaigns","count":9,"route":{"name":"campaigns"}},
   "email_sent":{"title":"Emails Sent","count":15420,"route":{"name":"all_emails"}},
   "tags":{"title":"Tags","count":14,"route":{"name":"tags"}},
   "total_templates":{"title":"Email Templates","count":3,"route":{"name":"templates"}},
   "total_automations":{"title":"Active Automations","count":4,"route":{"name":"funnels"}},
   "email_pending":{"title":"Pending Emails","count":220,"route":{"name":"campaigns"}}},
 "sales":[],
 "dashboard_notices":[],
 "onboarding":{ ... },
 "quick_links":[{"title":"Contact Segments","url":"https://example.com/wp-admin/admin.php?page=fluentcrm-admin#/contact-groups/lists","icon":"el-icon-folder"}],
 "ff_config":{"is_installed":false,"create_form_link":"https://example.com/wp-admin/admin.php?page=fluent_forms#add=1"},
 "recommendation":false,
 "system_tips":""}
```
* `total_subscribers` counts only `status=subscribed`.
* `email_pending` appears only when the count is above 0.
* `sales` is filled by e-commerce integrations.

**Time series.** These are growth endpoints with an identical shape (`ReportingController.php:21-51`, `app/Services/Reporting.php:15-97`, `app/Services/ReportingHelperTrait.php`).
* Param: `date_range[]=<from>&date_range[]=<to>`. Values are any `strtotime` string, e.g. `2026-09-01`. The default is the last 30 days through tomorrow.
* Buckets:
  * Up to 62 days gives daily keys `"Y-m-d"`.
  * 63 to 92 days gives weekly buckets, still keyed by `Y-m-d` dates.
  * Over 92 days gives monthly keys `"M Y"`, e.g. `"Oct 2026"`.
* Missing buckets are `0`.

| Endpoint | Counts | api.php |
|---|---|---|
| GET `reports/subscribers` | New contacts by `created_at`. Counts only contacts currently `subscribed`. | :211 |
| GET `reports/email-sents` | `fc_campaign_emails` with status `sent`, by `scheduled_at` | :212 |
| GET `reports/email-opens` | url-metrics `type=open` | :213 |
| GET `reports/email-clicks` | url-metrics `type=click` | :214 |

```json
{"stats":{"2026-10-08":4,"2026-10-09":11,"2026-10-10":0,"2026-10-11":2},"__bench":0.01}
```

**GET `reports/emails`** (`api.php:221`, `ReportingController.php:53-81`)
* This is the global email log. Params: `status`, `page`, `per_page`.
* Returns `{"emails":<paginator of campaign-email rows with "subscriber":{..},"campaign":{..}>,"statuses":{"sent":15420,"failed":3} or null}`. `statuses` is filled only when `page=1`.

**GET `reports/ping`** returns `{"message":"pong"}` (`:110-115`). Use it as an auth or health check.

"Recent subscribers" has no dedicated endpoint. Use `GET subscribers?sort_by=created_at&sort_type=DESC&per_page=10`, or `sort_by=id`.

---

## 6. Companies and automations (brief)
* **Companies** (`api.php:378-403`, CompanyPolicy) work only when the experimental company module is enabled. Otherwise every call returns `rest_forbidden`.
  * **GET `companies`** (`CompanyController.php:20-58`) takes `search`, `sort_by`, `sort_order`, and `page`/`per_page`, and returns `{"companies":<paginator>}`.
  * Also available: GET/PUT/DELETE `companies/{id}`, POST `companies`, POST `companies/attach-subscribers`, and POST `companies/detach-subscribers`.
* **Automations (funnels)**: **GET `funnels`** (`api.php:159`, `FunnelController.php:36-72`).
  * Params: `search`, `sort_by`, `sort_type`, `labels[]`, `with[]=triggers`, and `page`/`per_page`.
  * Returns `{"funnels":<paginator of {id,type:"funnel",title,trigger_name,status:"draft"|"published",conditions,settings,created_by,created_at,updated_at,subscribers_count,description,labels}>}`.

---

## 7. Quick map for MCP tool design

| Tool intent | Call | Mutates? |
|---|---|---|
| find contacts | GET subscribers (search, tags[], lists[], statuses[], sort_by, sort_type, page, per_page) | no |
| get contact | GET subscribers/{id}?with[]=stats&with[]=subscriber.custom_values | no |
| get contact by email | GET subscribers/0?get_by_email=… | no |
| create / upsert contact | POST subscribers (+`__force_update=yes`) | yes |
| update contact | PUT subscribers/{id} | yes |
| tag / untag (ids) | POST subscribers/do-bulk-action add_to_tags/remove_from_tags + action_options | yes |
| tag / untag (slugs) | POST subscribers/sync-segments type=tags attach/detach | yes |
| list membership | the same two endpoints with lists | yes |
| change status | PUT subscribers/subscribers-property property=status | yes |
| notes | GET/POST subscribers/{id}/notes | POST yes |
| contact email history | GET subscribers/{id}/emails | no |
| tags / lists | GET tags, GET lists (lists is non-paginated) | no |
| campaigns | GET campaigns?with[]=stats, GET campaigns/{id} | no |
| campaign report | GET campaigns/{id}/overview_stats, /link-report, /unsubscribers | no |
| draft campaign | POST campaigns {title} → PUT campaigns/{id} → POST draft-recipients | yes (no send) |
| **send/schedule (guard)** | POST campaigns/{id}/subscribe, POST campaigns/{id}/schedule, GET processing-stat, POST resume, POST send-test-email, POST subscribers/{id}/emails/send, POST send-double-optin | **sends email** |
| dashboard | GET reports/dashboard-stats, GET reports/subscribers?date_range[]=…&date_range[]=… | no |
| sequences | GET sequences (Pro; 404 on free) | no |
