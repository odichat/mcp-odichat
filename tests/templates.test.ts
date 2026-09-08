import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ChatwootClient } from "@/client.ts";
import {
  buildTemplateContent,
  fetchTemplatesRaw,
  fetchTwilioTemplates,
  findApprovedTemplate,
  isMetaShape,
  type MessageTemplate,
  parseFutureDate,
  requiredExtraParams,
  resolveInboxId,
  scheduleTemplateMessage,
} from "@/templates.ts";

const BASE_URL = "https://chatwoot.example.com";

function template(over: Partial<MessageTemplate> = {}): MessageTemplate {
  return {
    friendly_name: "call_reminder_1h",
    body: "Hola {{1}}, nos vemos en la llamada de las {{2}} — hablamos pronto!",
    status: "approved",
    category: "utility",
    language: "es_ES",
    variables: { "1": "Juan", "2": "11AM" },
    template_type: "quick_reply",
    content_sid: "HX123",
    ...over,
  };
}

/** Installs a fetch mock returning `body` for every call. */
function installMock(body: unknown, status = 200) {
  const m = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  // biome-ignore lint/suspicious/noExplicitAny: mock fetch override
  globalThis.fetch = m as any;
  return m;
}

/** Installs a fetch mock that picks a response based on the request URL. */
function installRouteMock(route: (url: string) => Response) {
  const m = mock((input: unknown) => Promise.resolve(route(String(input))));
  // biome-ignore lint/suspicious/noExplicitAny: mock fetch override
  globalThis.fetch = m as any;
  return m;
}

describe("buildTemplateContent", () => {
  test("maps {{1}} to Liquid drops and {{2}}+ to caller literals", () => {
    const result = buildTemplateContent(template(), { "2": "10:00 AM" });

    // {{1}} -> first_name in content, full name in processed_params.
    expect(result.content).toBe(
      "Hola {{contact.first_name}}, nos vemos en la llamada de las 10:00 AM — hablamos pronto!",
    );
    expect(result.template_params).toEqual({
      name: "call_reminder_1h",
      language: "es_ES",
      category: "utility",
      processed_params: { "1": "{{contact.name}}", "2": "10:00 AM" },
    });
  });

  test("handles a template whose only placeholder is {{1}}", () => {
    const tpl = template({
      friendly_name: "ctwa_reengage_01_retomar",
      body: "Hola {{1}}, soy Andrés.",
      variables: { "1": "Juan Lopez" },
    });
    const result = buildTemplateContent(tpl);

    expect(result.content).toBe("Hola {{contact.first_name}}, soy Andrés.");
    expect(result.template_params.processed_params).toEqual({
      "1": "{{contact.name}}",
    });
  });

  test("replaces every occurrence and tolerates inner whitespace", () => {
    const tpl = template({
      body: "{{1}} — {{ 2 }} y otra vez {{2}}",
      variables: { "1": "Juan", "2": "11AM" },
    });
    const result = buildTemplateContent(tpl, { "2": "10:00 AM" });

    expect(result.content).toBe(
      "{{contact.first_name}} — 10:00 AM y otra vez 10:00 AM",
    );
  });

  test("rejects a missing extra param, naming it with its example value", () => {
    expect(() => buildTemplateContent(template())).toThrow(
      'requires extra_params for "2" (e.g. "11AM")',
    );
  });

  test("rejects an unknown extra param", () => {
    expect(() =>
      buildTemplateContent(template(), { "2": "10:00 AM", "3": "x" }),
    ).toThrow('has no placeholder(s) "3"');
  });

  test('rejects "1" rather than silently discarding it', () => {
    expect(() =>
      buildTemplateContent(template(), { "1": "Bob", "2": "10:00 AM" }),
    ).toThrow('extra_params must not contain "1"');
  });

  test("rejects named placeholders", () => {
    const tpl = template({
      friendly_name: "notification_order_tracking",
      body: "Order {{order_number}} arrives {{time}}",
      variables: { time: "June 28th", order_number: "#79326" },
    });
    expect(() => buildTemplateContent(tpl, {})).toThrow(
      "uses named placeholders (time, order_number)",
    );
  });

  test("rejects an empty body", () => {
    const tpl = template({ body: "", variables: {} });
    expect(() => buildTemplateContent(tpl)).toThrow("has an empty body");
  });

  test("handles a template with no placeholders at all", () => {
    const tpl = template({ body: "Sin variables.", variables: {} });
    const result = buildTemplateContent(tpl);

    expect(result.content).toBe("Sin variables.");
    expect(result.template_params.processed_params).toEqual({});
  });
});

describe("requiredExtraParams", () => {
  test("excludes 1, which is filled in automatically", () => {
    expect(requiredExtraParams(template())).toEqual(["2"]);
  });

  test("tolerates a template with no variables field", () => {
    const tpl = {
      ...template(),
      variables: undefined,
    } as unknown as MessageTemplate;
    expect(requiredExtraParams(tpl)).toEqual([]);
  });
});

describe("findApprovedTemplate", () => {
  const templates = [
    template(),
    template({ friendly_name: "call_ongoing_now" }),
    template({ friendly_name: "message_opt_in", status: "unsubmitted" }),
  ];

  test("finds an approved template by friendly_name", () => {
    expect(
      findApprovedTemplate(templates, "call_ongoing_now").friendly_name,
    ).toBe("call_ongoing_now");
  });

  test("lists the approved names when the name is unknown", () => {
    expect(() => findApprovedTemplate(templates, "call_reminder_1hr")).toThrow(
      'No template named "call_reminder_1hr" in this inbox. Approved templates: call_reminder_1h, call_ongoing_now',
    );
  });

  test("distinguishes an existing-but-unapproved template", () => {
    expect(() => findApprovedTemplate(templates, "message_opt_in")).toThrow(
      'exists but its status is "unsubmitted"',
    );
  });

  test("reports (none) when no template is approved", () => {
    const unapproved = [template({ status: "unsubmitted" })];
    expect(() => findApprovedTemplate(unapproved, "nope")).toThrow("(none)");
  });
});

describe("isMetaShape", () => {
  test("detects the Meta Graph shape", () => {
    expect(isMetaShape([{ name: "x", components: [] }])).toBe(true);
  });

  test("does not flag the Twilio shape", () => {
    expect(isMetaShape([template()])).toBe(false);
  });

  test("treats an empty payload as not-Meta", () => {
    expect(isMetaShape([])).toBe(false);
  });
});

describe("fetchTemplatesRaw", () => {
  let client: ChatwootClient;

  beforeEach(() => {
    client = new ChatwootClient(BASE_URL, "token");
  });

  test("requests the per-inbox templates path", async () => {
    const m = installMock({ payload: [template()] });
    await fetchTemplatesRaw(client, 1, 68);

    const url = String((m.mock.calls as unknown[][])[0]?.[0] ?? "");
    expect(url).toBe(
      "https://chatwoot.example.com/api/v1/accounts/1/inboxes/68/message_templates",
    );
  });

  test("caches per client instance, so a repeat call makes no request", async () => {
    const m = installMock({ payload: [template()] });
    await fetchTemplatesRaw(client, 1, 68);
    await fetchTemplatesRaw(client, 1, 68);

    expect(m.mock.calls.length).toBe(1);
  });

  test("does not share cached templates between client instances", async () => {
    const m = installMock({ payload: [template()] });
    await fetchTemplatesRaw(client, 1, 68);
    // A second tenant's client must not read the first tenant's templates.
    await fetchTemplatesRaw(new ChatwootClient(BASE_URL, "other-token"), 1, 68);

    expect(m.mock.calls.length).toBe(2);
  });

  test("caches per inbox", async () => {
    const m = installMock({ payload: [template()] });
    await fetchTemplatesRaw(client, 1, 68);
    await fetchTemplatesRaw(client, 1, 50);

    expect(m.mock.calls.length).toBe(2);
  });

  test("returns an empty array when payload is absent", async () => {
    installMock({});
    expect(await fetchTemplatesRaw(client, 1, 68)).toEqual([]);
  });
});

describe("fetchTwilioTemplates", () => {
  test("returns the Twilio-shaped payload", async () => {
    installMock({ payload: [template()] });
    const client = new ChatwootClient(BASE_URL, "token");

    const templates = await fetchTwilioTemplates(client, 1, 68);
    expect(templates[0]?.friendly_name).toBe("call_reminder_1h");
  });

  test("rejects a Meta-shape inbox, naming its channel type", async () => {
    installRouteMock((url) =>
      Response.json(
        url.includes("message_templates")
          ? { payload: [{ name: "x", components: [] }] }
          : { name: "Business App", channel_type: "Channel::Whatsapp" },
      ),
    );
    const client = new ChatwootClient(BASE_URL, "token");

    expect(fetchTwilioTemplates(client, 1, 50)).rejects.toThrow(
      "Inbox Business App (Channel::Whatsapp) returns Meta Cloud API templates",
    );
  });

  test("still rejects when the inbox lookup itself fails", async () => {
    installRouteMock((url) =>
      url.includes("message_templates")
        ? Response.json({ payload: [{ name: "x", components: [] }] })
        : Response.json({ error: "nope" }, { status: 500 }),
    );
    const client = new ChatwootClient(BASE_URL, "token");

    expect(fetchTwilioTemplates(client, 1, 50)).rejects.toThrow(
      "Inbox id 50 returns Meta Cloud API templates",
    );
  });
});

describe("resolveInboxId", () => {
  test("reads inbox_id off the conversation", async () => {
    const m = installMock({ id: 163, database_id: 107259, inbox_id: 68 });
    const client = new ChatwootClient(BASE_URL, "token");

    expect(await resolveInboxId(client, 1, 163)).toBe(68);
    const url = String((m.mock.calls as unknown[][])[0]?.[0] ?? "");
    expect(url).toEndWith("/api/v1/accounts/1/conversations/163");
  });

  test("points at display_id when the inbox cannot be determined", async () => {
    installMock({});
    const client = new ChatwootClient(BASE_URL, "token");

    expect(resolveInboxId(client, 1, 107259)).rejects.toThrow(
      "not its internal database id",
    );
  });
});

describe("parseFutureDate", () => {
  test("returns the parsed date when it is in the future", () => {
    const date = parseFutureDate("2099-01-01T00:00:00Z", "scheduled_at");
    expect(date.toISOString()).toBe("2099-01-01T00:00:00.000Z");
  });

  test("rejects an unparseable value", () => {
    expect(() => parseFutureDate("next tuesday", "scheduled_at")).toThrow(
      "is not a valid ISO 8601 datetime",
    );
  });

  test("rejects a past value before any request is made", () => {
    expect(() =>
      parseFutureDate("2020-01-01T00:00:00Z", "scheduled_at"),
    ).toThrow("scheduled_at must be in the future");
  });
});

describe("scheduleTemplateMessage", () => {
  test("posts to the display_id path with status pending", async () => {
    const m = installMock({ id: 42 });
    const client = new ChatwootClient(BASE_URL, "token");

    const result = await scheduleTemplateMessage(client, {
      accountId: 1,
      conversationId: 163,
      template: template(),
      scheduledAt: new Date("2099-01-01T00:00:00Z"),
      extraParams: { "2": "10:00 AM" },
    });

    expect(result.id).toBe(42);

    const call = (m.mock.calls as unknown[][])[0];
    expect(String(call?.[0])).toEndWith(
      "/api/v1/accounts/1/conversations/163/scheduled_messages",
    );
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body.status).toBe("pending");
    expect(body.hold_on_reply).toBe(true);
    expect(body.scheduled_at).toBe("2099-01-01T00:00:00.000Z");
    expect(body.template_params.name).toBe("call_reminder_1h");
    expect(body.content).toContain("{{contact.first_name}}");
  });

  test("honours hold_on_reply false", async () => {
    const m = installMock({ id: 43 });
    const client = new ChatwootClient(BASE_URL, "token");

    await scheduleTemplateMessage(client, {
      accountId: 1,
      conversationId: 163,
      template: template(),
      scheduledAt: new Date("2099-01-01T00:00:00Z"),
      extraParams: { "2": "10:00 AM" },
      holdOnReply: false,
    });

    const body = JSON.parse(
      String(((m.mock.calls as unknown[][])[0]?.[1] as RequestInit).body),
    );
    expect(body.hold_on_reply).toBe(false);
  });
});
