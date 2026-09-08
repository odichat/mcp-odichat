import { z } from "zod";
import {
  fetchTwilioTemplates,
  findApprovedTemplate,
  parseFutureDate,
  resolveInboxId,
  scheduleTemplateMessage,
} from "@/templates.ts";
import type { RegisterFn } from "@/types.ts";

const accountId = z.number().describe("The account ID");

export const register: RegisterFn = (server, client) => {
  // NOTE: `conversationId` here is the conversation's **display_id** — the number
  // shown in the Odichat UI and in conversation URLs — not the internal database
  // id. This is counter-intuitive but verified: posting with the display_id
  // resolves the conversation, while posting with the internal `database_id`
  // returns 404 "Resource could not be found". Do not "fix" this to the
  // internal id.
  const base = (accountId: number, conversationId: number) =>
    `/api/v1/accounts/${accountId}/conversations/${conversationId}/scheduled_messages`;

  server.registerTool(
    "scheduled_messages_list",
    {
      title: "List Scheduled Messages",
      description: "[Odichat] List scheduled messages for a conversation",
      inputSchema: {
        account_id: accountId,
        conversation_id: z.number().describe("Conversation ID (display_id)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ account_id, conversation_id }) => {
      const result = await client.get(base(account_id, conversation_id));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "scheduled_messages_create",
    {
      title: "Create Scheduled Message",
      description:
        "[Odichat] Schedule a message to be sent later in a conversation. " +
        "Defaults to status 'pending' so the message is actually delivered — " +
        "a 'draft' is stored but never sent.",
      inputSchema: {
        account_id: accountId,
        conversation_id: z.number().describe("Conversation ID (display_id)"),
        content: z.string().describe("Message content"),
        scheduled_at: z
          .string()
          .describe("ISO 8601 datetime for when to send the message"),
        // The API only enforces "scheduled_at must be in the future" when the
        // status is `pending`. Omitting it stores a `draft` that silently
        // accepts past timestamps and is never delivered, so default to
        // `pending` rather than relying on the server default.
        status: z
          .enum(["pending", "draft"])
          .optional()
          .default("pending")
          .describe(
            "'pending' schedules the message for delivery (default); " +
              "'draft' stores it without ever sending it",
          ),
        hold_on_reply: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Cancel the scheduled message if the contact replies first (server default is false)",
          ),
        template_params: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "WhatsApp template payload: { name, language, category, processed_params }",
          ),
        message_type: z
          .enum(["outgoing", "incoming"])
          .optional()
          .describe("Message type"),
      },
    },
    async ({ account_id, conversation_id, ...body }) => {
      const result = await client.post(base(account_id, conversation_id), body);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "scheduled_messages_create_from_template",
    {
      title: "Schedule a Template Message",
      description:
        "[Odichat] Schedule an approved WhatsApp template message in a " +
        "conversation. Looks the template up by its friendly_name on the " +
        "conversation's own inbox, fills in the contact's name automatically, " +
        "and schedules it for delivery. Only Twilio-backed WhatsApp inboxes " +
        "are supported. Use message_templates_list to see the available names.",
      inputSchema: {
        account_id: accountId,
        conversation_id: z.number().describe("Conversation ID (display_id)"),
        template_name: z
          .string()
          .describe("The template's friendly_name; must be approved"),
        scheduled_at: z
          .string()
          .describe(
            "Absolute ISO 8601 UTC datetime, must be in the future (e.g. 2026-09-09T15:30:00Z)",
          ),
        extra_params: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Literal values for placeholders {{2}} and up, keyed by placeholder " +
              'number. Never include "1" — that is the contact\'s name and is ' +
              "filled in automatically.",
          ),
        hold_on_reply: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Cancel the scheduled message if the contact replies first",
          ),
      },
    },
    async ({
      account_id,
      conversation_id,
      template_name,
      scheduled_at,
      extra_params,
      hold_on_reply,
    }) => {
      // Validate everything cheap before any write. The API would not
      // necessarily reject a past timestamp itself — it stores an undelivered
      // draft instead — so this check is doing real work, not just pre-empting
      // a 422.
      const scheduledAt = parseFutureDate(scheduled_at, "scheduled_at");

      // The inbox is derived rather than accepted as a parameter: a conversation
      // belongs to exactly one inbox, so there is no legitimate case for
      // scheduling against a different inbox's template list.
      const inboxId = await resolveInboxId(client, account_id, conversation_id);
      const templates = await fetchTwilioTemplates(client, account_id, inboxId);
      const template = findApprovedTemplate(templates, template_name);

      const result = await scheduleTemplateMessage(client, {
        accountId: account_id,
        conversationId: conversation_id,
        template,
        scheduledAt,
        extraParams: extra_params,
        holdOnReply: hold_on_reply,
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Scheduled template "${template_name}" for ` +
              `${scheduledAt.toISOString()} (scheduled message id ${result.id}).\n\n` +
              JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "scheduled_messages_update",
    {
      title: "Update Scheduled Message",
      description: "[Odichat] Update a scheduled message",
      inputSchema: {
        account_id: accountId,
        conversation_id: z.number().describe("Conversation ID (display_id)"),
        scheduled_message_id: z.number().describe("Scheduled message ID"),
        content: z.string().optional().describe("Message content"),
        scheduled_at: z.string().optional().describe("ISO 8601 datetime"),
        status: z
          .enum(["pending", "draft"])
          .optional()
          .describe("'pending' to schedule for delivery, 'draft' to hold"),
        hold_on_reply: z
          .boolean()
          .optional()
          .describe(
            "Cancel the scheduled message if the contact replies first",
          ),
      },
      annotations: { idempotentHint: true },
    },
    async ({ account_id, conversation_id, scheduled_message_id, ...body }) => {
      const result = await client.patch(
        `${base(account_id, conversation_id)}/${scheduled_message_id}`,
        body,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "scheduled_messages_delete",
    {
      title: "Delete Scheduled Message",
      description: "[Odichat] Delete a scheduled message",
      inputSchema: {
        account_id: accountId,
        conversation_id: z.number().describe("Conversation ID (display_id)"),
        scheduled_message_id: z.number().describe("Scheduled message ID"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ account_id, conversation_id, scheduled_message_id }) => {
      await client.delete(
        `${base(account_id, conversation_id)}/${scheduled_message_id}`,
      );
      return {
        content: [
          { type: "text", text: "Scheduled message deleted successfully" },
        ],
      };
    },
  );
};
