/**
 * WhatsApp message template lookup and substitution.
 *
 * Scoped to the Twilio Content API template shape, which is what
 * `Channel::TwilioSms` inboxes return. Native `Channel::Whatsapp` inboxes
 * return the raw Meta Graph shape instead (`name` + `components[]`, uppercase
 * `status`/`category`, no `body`); that shape is deliberately unsupported and
 * is rejected loudly rather than parsed — see `assertTwilioShape`.
 */

import type { ChatwootClient } from "@/client.ts";

/** A template as returned by a `Channel::TwilioSms` inbox. */
export interface MessageTemplate {
  friendly_name: string;
  body: string;
  status: string;
  category: string;
  language: string;
  /**
   * Placeholder set for this template, mapping placeholder key to an example
   * value — e.g. `{ "1": "Juan", "2": "11AM" }`.
   *
   * This is the source of truth for which placeholders a template has. Scanning
   * `body` for `{{n}}` is not equivalent: some templates use *named* keys
   * (`{ "time": …, "order_number": … }`) and some have an empty `body`.
   */
  variables: Record<string, string>;
  template_type: string;
  content_sid: string;
}

/** The `template_params` payload attached to a scheduled message. */
export interface TemplateParams {
  name: string;
  language: string;
  category: string;
  processed_params: Record<string, string>;
}

const TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Template cache, scoped to the `ChatwootClient` instance.
 *
 * Deliberately *not* a module-level map keyed on account/inbox id: in HTTP mode
 * this server is stateless and multi-tenant, building a fresh client per request
 * from a caller-supplied `?token=`. A cache keyed only on ids would serve one
 * tenant's templates to another.
 *
 * Keying on the client instance means stdio mode (one long-lived client) gets a
 * real TTL cache, while HTTP mode degrades to per-request memoisation — which is
 * what the call-reminder tool needs, since it resolves two templates in one call.
 */
const cache = new WeakMap<
  ChatwootClient,
  Map<string, { at: number; payload: unknown[] }>
>();

function cacheFor(client: ChatwootClient) {
  let store = cache.get(client);
  if (!store) {
    store = new Map();
    cache.set(client, store);
  }
  return store;
}

/**
 * Fetches an inbox's templates verbatim, with no shape validation.
 *
 * Used by the listing tool, which should stay able to show whatever an inbox
 * actually returns — including the Meta shape the scheduling tools reject.
 */
export async function fetchTemplatesRaw(
  client: ChatwootClient,
  accountId: number,
  inboxId: number,
): Promise<unknown[]> {
  const key = `${accountId}:${inboxId}`;
  const store = cacheFor(client);
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < TEMPLATE_CACHE_TTL_MS) {
    return hit.payload;
  }

  const result = await client.get<{ payload?: unknown[] }>(
    `/api/v1/accounts/${accountId}/inboxes/${inboxId}/message_templates`,
  );
  const payload = Array.isArray(result?.payload) ? result.payload : [];
  store.set(key, { at: Date.now(), payload });
  return payload;
}

/** True when the payload looks like the Meta Graph shape rather than Twilio's. */
export function isMetaShape(payload: unknown[]): boolean {
  const first = payload[0] as Record<string, unknown> | undefined;
  if (!first) return false;
  return !("friendly_name" in first) && "components" in first;
}

async function describeInbox(
  client: ChatwootClient,
  accountId: number,
  inboxId: number,
): Promise<string> {
  try {
    const inbox = await client.get<{ channel_type?: string; name?: string }>(
      `/api/v1/accounts/${accountId}/inboxes/${inboxId}/`,
    );
    return `${inbox?.name ?? "unknown"} (${inbox?.channel_type ?? "unknown channel"})`;
  } catch {
    // Naming the channel is a nicety in an error path — never mask the real
    // problem because this lookup failed.
    return `id ${inboxId}`;
  }
}

/**
 * Fetches an inbox's templates and asserts they are the Twilio shape.
 *
 * Throws a message naming the inbox and its channel type when pointed at a
 * native WhatsApp inbox, so an unsupported channel is an obvious failure rather
 * than a silent one.
 */
export async function fetchTwilioTemplates(
  client: ChatwootClient,
  accountId: number,
  inboxId: number,
): Promise<MessageTemplate[]> {
  const payload = await fetchTemplatesRaw(client, accountId, inboxId);

  if (isMetaShape(payload)) {
    const inbox = await describeInbox(client, accountId, inboxId);
    throw new Error(
      `Inbox ${inbox} returns Meta Cloud API templates, which the template ` +
        `scheduling tools do not support. Only Twilio-backed WhatsApp inboxes ` +
        `(Channel::TwilioSms) can be used with template scheduled messages. ` +
        `Use messages_create to send to this inbox instead.`,
    );
  }

  return payload as MessageTemplate[];
}

/**
 * Looks up an approved template by `friendly_name`.
 *
 * The API returns unapproved templates too — several live inboxes carry
 * `status: "unsubmitted"` entries — so approval is filtered here rather than
 * assumed.
 */
export function findApprovedTemplate(
  templates: MessageTemplate[],
  name: string,
): MessageTemplate {
  const approved = templates.filter((t) => t.status === "approved");
  const match = approved.find((t) => t.friendly_name === name);
  if (match) return match;

  const unapproved = templates.find((t) => t.friendly_name === name);
  if (unapproved) {
    throw new Error(
      `Template "${name}" exists but its status is "${unapproved.status}", ` +
        `not "approved", so it cannot be sent. ` +
        `Approved templates: ${listNames(approved)}`,
    );
  }

  throw new Error(
    `No template named "${name}" in this inbox. ` +
      `Approved templates: ${listNames(approved)}`,
  );
}

function listNames(templates: MessageTemplate[]): string {
  if (templates.length === 0) return "(none)";
  return templates.map((t) => t.friendly_name).join(", ");
}

/** Placeholder keys a caller must supply — everything except `1`. */
export function requiredExtraParams(template: MessageTemplate): string[] {
  return Object.keys(template.variables ?? {}).filter((k) => k !== "1");
}

/**
 * Builds the `content` and `template_params` for a scheduled template message.
 *
 * Two different curly-brace syntaxes are in play and must not be conflated:
 *
 *   - `{{1}}`, `{{2}}` … in a template `body` are Twilio/Meta placeholders.
 *   - `{{contact.name}}`, `{{contact.first_name}}` … are Chatwoot Liquid drops,
 *     resolved server-side.
 *
 * `{{1}}` is the contact's name in every template seen so far. The working
 * pattern substitutes the Liquid drop `{{contact.first_name}}` into `content`
 * (rendered by Chatwoot at schedule-creation time) while `processed_params["1"]`
 * carries `{{contact.name}}` (rendered at send time). The first-name/full-name
 * split is a convention, not something the template metadata enforces — the
 * templates' own example values are inconsistent about which is expected.
 *
 * `{{2}}` and up have no Chatwoot equivalent and must be supplied by the caller
 * as literal, pre-formatted values.
 */
export function buildTemplateContent(
  template: MessageTemplate,
  extraParams: Record<string, string> = {},
): { content: string; template_params: TemplateParams } {
  const placeholders = Object.keys(template.variables ?? {});

  const named = placeholders.filter((k) => !/^[1-9]\d*$/.test(k));
  if (named.length > 0) {
    throw new Error(
      `Template "${template.friendly_name}" uses named placeholders ` +
        `(${named.join(", ")}) rather than positional ones ({{1}}, {{2}}, …), ` +
        `which is not supported.`,
    );
  }

  if (!template.body) {
    throw new Error(
      `Template "${template.friendly_name}" has an empty body, so no message ` +
        `content can be built from it.`,
    );
  }

  if (extraParams["1"] !== undefined) {
    throw new Error(
      `extra_params must not contain "1" for template ` +
        `"${template.friendly_name}". Placeholder {{1}} is the contact's name ` +
        `and is filled in automatically.`,
    );
  }

  const required = requiredExtraParams(template);
  const missing = required.filter((k) => extraParams[k] === undefined);
  if (missing.length > 0) {
    const hints = missing
      .map((k) => `"${k}" (e.g. "${template.variables[k]}")`)
      .join(", ");
    throw new Error(
      `Template "${template.friendly_name}" requires extra_params for ${hints}.`,
    );
  }

  const unknown = Object.keys(extraParams).filter(
    (k) => !placeholders.includes(k),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Template "${template.friendly_name}" has no placeholder(s) ` +
        `${unknown.map((k) => `"${k}"`).join(", ")}. ` +
        `It accepts: ${placeholders.join(", ") || "(none)"}.`,
    );
  }

  const processed_params: Record<string, string> = {};
  let content = template.body;

  for (const key of placeholders) {
    // `{{1}}` resolves to the contact's name via Chatwoot's Liquid drops;
    // everything else is a literal supplied by the caller.
    const contentValue =
      key === "1" ? "{{contact.first_name}}" : extraParams[key];
    const paramValue = key === "1" ? "{{contact.name}}" : extraParams[key];
    content = content.replace(placeholderPattern(key), contentValue as string);
    processed_params[key] = paramValue as string;
  }

  return {
    content,
    template_params: {
      name: template.friendly_name,
      language: template.language,
      category: template.category,
      processed_params,
    },
  };
}

function placeholderPattern(key: string): RegExp {
  return new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g");
}

/**
 * Resolves the inbox a conversation belongs to.
 *
 * A conversation belongs to exactly one inbox, so the inbox is never a caller
 * parameter on the scheduling tools — deriving it removes any way to point a
 * tool at the wrong inbox's template list for a given conversation.
 */
export async function resolveInboxId(
  client: ChatwootClient,
  accountId: number,
  conversationId: number,
): Promise<number> {
  const conversation = await client.get<{ inbox_id?: number }>(
    `/api/v1/accounts/${accountId}/conversations/${conversationId}`,
  );
  const inboxId = conversation?.inbox_id;
  if (typeof inboxId !== "number") {
    throw new Error(
      `Could not determine the inbox for conversation ${conversationId}. ` +
        `Check that ${conversationId} is the conversation's display_id ` +
        `(the number shown in the Odichat UI), not its internal database id.`,
    );
  }
  return inboxId;
}

/** Rejects a scheduled time that is missing, unparseable, or not in the future. */
export function parseFutureDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `${field} "${value}" is not a valid ISO 8601 datetime. ` +
        `Use an absolute UTC timestamp, e.g. 2026-09-09T15:30:00Z.`,
    );
  }
  if (date.getTime() <= Date.now()) {
    throw new Error(
      `${field} must be in the future. Got ${date.toISOString()}, ` +
        `which is in the past (now is ${new Date().toISOString()}).`,
    );
  }
  return date;
}

/**
 * Creates one scheduled message from an already-resolved template.
 *
 * Always posts `status: "pending"` — a draft is stored but never delivered.
 */
export async function scheduleTemplateMessage(
  client: ChatwootClient,
  params: {
    accountId: number;
    conversationId: number;
    template: MessageTemplate;
    scheduledAt: Date;
    extraParams?: Record<string, string>;
    holdOnReply?: boolean;
  },
): Promise<{ id?: number } & Record<string, unknown>> {
  const { content, template_params } = buildTemplateContent(
    params.template,
    params.extraParams ?? {},
  );

  return client.post(
    // display_id, not the internal database id — see scheduled-messages.ts
    `/api/v1/accounts/${params.accountId}/conversations/${params.conversationId}/scheduled_messages`,
    {
      status: "pending",
      hold_on_reply: params.holdOnReply ?? true,
      scheduled_at: params.scheduledAt.toISOString(),
      content,
      template_params,
    },
  );
}
