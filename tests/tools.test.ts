import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ChatwootClient } from "@/client.ts";
import { createServer } from "@/server.ts";

const BASE_URL = "https://chatwoot.example.com";

const TEMPLATES = [
  {
    friendly_name: "call_reminder_1h",
    body: "Hola {{1}}, nos vemos en la llamada de las {{2}} — hablamos pronto!",
    status: "approved",
    category: "utility",
    language: "es_ES",
    variables: { "1": "Juan", "2": "11AM" },
    template_type: "quick_reply",
    content_sid: "HX1",
  },
  {
    friendly_name: "call_ongoing_now",
    body: "Hola, {{1}}. Tu llamada de las {{2}} está en curso.",
    status: "approved",
    category: "utility",
    language: "es_ES",
    variables: { "1": "Juan", "2": "11AM" },
    template_type: "quick_reply",
    content_sid: "HX2",
  },
];

interface Recorded {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/**
 * Drives a tool through the real server registry against a mocked Chatwoot,
 * returning the tool's text output plus every request it made.
 */
function harness() {
  const requests: Recorded[] = [];
  let nextId = 100;

  const fetchMock = mock((input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    if (url.includes("/message_templates")) {
      return Promise.resolve(Response.json({ payload: TEMPLATES }));
    }
    if (url.includes("/scheduled_messages")) {
      nextId += 1;
      return Promise.resolve(Response.json({ id: nextId, status: "pending" }));
    }
    // A conversation lookup.
    return Promise.resolve(
      Response.json({ id: 163, database_id: 107259, inbox_id: 68 }),
    );
  });
  // biome-ignore lint/suspicious/noExplicitAny: mock fetch override
  globalThis.fetch = fetchMock as any;

  const server = createServer(new ChatwootClient(BASE_URL, "token"));
  // biome-ignore lint/suspicious/noExplicitAny: reading the registry to drive tools
  const tools = (server as any)._registeredTools;

  return {
    requests,
    async call(name: string, args: Record<string, unknown>) {
      const result = await tools[name].handler(args, {});
      return result.content[0].text as string;
    },
    writes() {
      return requests.filter((r) => r.method === "POST");
    },
  };
}

/** A naive local time `minutes` from now, in a fixed-offset zone (UTC-4). */
function localIn(minutes: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Caracas",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .formatToParts(new Date(Date.now() + minutes * 60_000))
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

/** Parameter names a registered tool accepts. */
function paramsOf(name: string): string[] {
  const server = createServer(new ChatwootClient(BASE_URL, "token"));
  // biome-ignore lint/suspicious/noExplicitAny: reading the registry
  const tool = (server as any)._registeredTools[name];
  // biome-ignore lint/suspicious/noExplicitAny: the SDK normalises to a ZodObject
  return Object.keys((tool.inputSchema as any).shape ?? {});
}

/** Mocks an inbox that returns Meta Graph shaped templates. */
function installMetaShapeMock() {
  const m = mock(() =>
    Promise.resolve(
      Response.json({ payload: [{ name: "x", components: [] }] }),
    ),
  );
  // biome-ignore lint/suspicious/noExplicitAny: mock fetch override
  globalThis.fetch = m as any;
  return m;
}

describe("scheduled_messages_create_from_template", () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  test("derives the inbox from the conversation and posts a pending message", async () => {
    const text = await h.call("scheduled_messages_create_from_template", {
      account_id: 1,
      conversation_id: 163,
      template_name: "call_reminder_1h",
      scheduled_at: "2099-01-01T12:00:00Z",
      extra_params: { "2": "10:00 AM" },
      hold_on_reply: true,
    });

    expect(text).toContain('Scheduled template "call_reminder_1h"');
    expect(text).toContain("scheduled message id 101");

    // Inbox 68 came from the conversation, not from a parameter.
    expect(
      h.requests.some((r) => r.url.endsWith("/inboxes/68/message_templates")),
    ).toBe(true);

    const post = h.writes()[0];
    expect(post?.url).toEndWith("/conversations/163/scheduled_messages");
    expect(post?.body?.status).toBe("pending");
    expect(post?.body?.content).toBe(
      "Hola {{contact.first_name}}, nos vemos en la llamada de las 10:00 AM — hablamos pronto!",
    );
  });

  test("takes no inbox_id parameter", () => {
    const params = paramsOf("scheduled_messages_create_from_template");
    expect(params).toContain("conversation_id");
    expect(params).not.toContain("inbox_id");
  });

  test("rejects a past timestamp without writing anything", async () => {
    expect(
      h.call("scheduled_messages_create_from_template", {
        account_id: 1,
        conversation_id: 163,
        template_name: "call_reminder_1h",
        scheduled_at: "2020-01-01T12:00:00Z",
        extra_params: { "2": "10:00 AM" },
      }),
    ).rejects.toThrow("scheduled_at must be in the future");
    expect(h.writes().length).toBe(0);
  });

  test("rejects an unknown template, listing the approved names", async () => {
    expect(
      h.call("scheduled_messages_create_from_template", {
        account_id: 1,
        conversation_id: 163,
        template_name: "call_reminder_1hr",
        scheduled_at: "2099-01-01T12:00:00Z",
        extra_params: { "2": "10:00 AM" },
      }),
    ).rejects.toThrow("Approved templates: call_reminder_1h, call_ongoing_now");
    expect(h.writes().length).toBe(0);
  });
});

describe("scheduled_messages_create_call_reminders", () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  test("schedules both messages an hour apart for a call three hours out", async () => {
    const text = await h.call("scheduled_messages_create_call_reminders", {
      account_id: 1,
      conversation_id: 163,
      call_time_local: localIn(180),
      iana_timezone: "America/Caracas",
    });

    expect(text).toContain('Scheduled "call_reminder_1h"');
    expect(text).toContain('Scheduled "call_ongoing_now"');

    const posts = h.writes();
    expect(posts.length).toBe(2);

    const [reminder, ongoing] = posts;
    expect(reminder?.body?.template_params).toMatchObject({
      name: "call_reminder_1h",
    });
    expect(ongoing?.body?.template_params).toMatchObject({
      name: "call_ongoing_now",
    });

    // Chronological, exactly one hour apart.
    const first = new Date(String(reminder?.body?.scheduled_at)).getTime();
    const second = new Date(String(ongoing?.body?.scheduled_at)).getTime();
    expect(second - first).toBe(60 * 60 * 1000);
  });

  test("puts the contact's local clock time in {{2}} on both messages", async () => {
    await h.call("scheduled_messages_create_call_reminders", {
      account_id: 1,
      conversation_id: 163,
      call_time_local: "2099-06-01T10:00",
      iana_timezone: "America/Caracas",
    });

    for (const post of h.writes()) {
      const params = post.body?.template_params as {
        processed_params: Record<string, string>;
      };
      expect(params.processed_params["2"]).toBe("10:00 AM");
      expect(params.processed_params["1"]).toBe("{{contact.name}}");
      // 10:00 Caracas is 14:00Z — the label is local, the instant is UTC.
      expect(String(post.body?.scheduled_at)).toContain("2099-06-01T");
    }
  });

  test("skips the 1h reminder when the call is under an hour away", async () => {
    const text = await h.call("scheduled_messages_create_call_reminders", {
      account_id: 1,
      conversation_id: 163,
      call_time_local: localIn(25),
      iana_timezone: "America/Caracas",
    });

    expect(text).toContain('Skipped "call_reminder_1h"');
    expect(text).toContain('Scheduled "call_ongoing_now"');

    // A skip is a normal outcome, so the other message is still created.
    const posts = h.writes();
    expect(posts.length).toBe(1);
    expect(posts[0]?.body?.template_params).toMatchObject({
      name: "call_ongoing_now",
    });
  });

  test("fetches the template list once for both messages", async () => {
    await h.call("scheduled_messages_create_call_reminders", {
      account_id: 1,
      conversation_id: 163,
      call_time_local: localIn(180),
      iana_timezone: "America/Caracas",
    });

    const templateFetches = h.requests.filter((r) =>
      r.url.includes("/message_templates"),
    );
    expect(templateFetches.length).toBe(1);
  });

  test("rejects a country name in place of an IANA identifier", async () => {
    expect(
      h.call("scheduled_messages_create_call_reminders", {
        account_id: 1,
        conversation_id: 163,
        call_time_local: localIn(180),
        iana_timezone: "Venezuela",
      }),
    ).rejects.toThrow("is not a valid IANA timezone identifier");
    expect(h.writes().length).toBe(0);
  });

  test("takes no inbox_id parameter", () => {
    const params = paramsOf("scheduled_messages_create_call_reminders");
    expect(params).toContain("conversation_id");
    expect(params).not.toContain("inbox_id");
  });

  test("rejects a call time already in the past", async () => {
    expect(
      h.call("scheduled_messages_create_call_reminders", {
        account_id: 1,
        conversation_id: 163,
        call_time_local: "2020-01-01T10:00",
        iana_timezone: "America/Caracas",
      }),
    ).rejects.toThrow("which is in the past");
    expect(h.writes().length).toBe(0);
  });
});

describe("request bodies the Rails API requires wrapped", () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  test("labels_create wraps the body in `label`", async () => {
    await h.call("labels_create", {
      account_id: 7,
      title: "motos",
      color: "#ef4444",
    });

    const post = h.writes()[0];
    expect(post?.url).toEndWith("/accounts/7/labels");
    expect(post?.body).toEqual({ label: { title: "motos", color: "#ef4444" } });
  });

  test("labels_update wraps the body in `label` and keeps the id in the path", async () => {
    await h.call("labels_update", { account_id: 7, id: 3, color: "#000000" });

    const patch = h.requests.find((r) => r.method === "PATCH");
    expect(patch?.url).toEndWith("/accounts/7/labels/3");
    expect(patch?.body).toEqual({ label: { color: "#000000" } });
  });

  test("kanban_steps_create wraps the body in `step`", async () => {
    await h.call("kanban_steps_create", {
      account_id: 7,
      board_id: 12,
      name: "Nuevo",
    });

    const post = h.writes()[0];
    expect(post?.url).toEndWith("/accounts/7/kanban/boards/12/steps");
    expect(post?.body).toEqual({ step: { name: "Nuevo" } });
  });

  test("kanban_steps_update wraps the body in `step`", async () => {
    await h.call("kanban_steps_update", {
      account_id: 7,
      board_id: 12,
      step_id: 72,
      name: "Nuevo lead",
    });

    const patch = h.requests.find((r) => r.method === "PATCH");
    expect(patch?.url).toEndWith("/accounts/7/kanban/boards/12/steps/72");
    expect(patch?.body).toEqual({ step: { name: "Nuevo lead" } });
  });
});

describe("message_templates_list", () => {
  test("requires an explicit inbox_id, having no conversation to derive one from", () => {
    expect(paramsOf("message_templates_list")).toContain("inbox_id");
  });

  test("flags an inbox that returns Meta-shaped templates", async () => {
    installMetaShapeMock();

    const server = createServer(new ChatwootClient(BASE_URL, "token"));
    // biome-ignore lint/suspicious/noExplicitAny: reading the registry
    const tool = (server as any)._registeredTools.message_templates_list;
    const result = await tool.handler({ account_id: 1, inbox_id: 50 }, {});

    expect(result.content[0].text).toContain("Meta Cloud API templates");
  });
});
