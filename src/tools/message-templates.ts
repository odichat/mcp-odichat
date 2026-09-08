import { z } from "zod";
import { fetchTemplatesRaw, isMetaShape } from "@/templates.ts";
import type { RegisterFn } from "@/types.ts";

export const register: RegisterFn = (server, client) => {
  server.registerTool(
    "message_templates_list",
    {
      title: "List Message Templates",
      description:
        "[Odichat] List the WhatsApp message templates available on an inbox. " +
        "Templates are scoped per inbox, not per account. The response includes " +
        "unapproved templates — only those with status 'approved' can be sent.",
      inputSchema: {
        account_id: z.number().describe("The account ID"),
        // Required here, unlike the scheduling tools: a standalone listing has no
        // conversation to derive the inbox from.
        inbox_id: z.number().describe("Inbox ID to list templates for"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ account_id, inbox_id }) => {
      const payload = await fetchTemplatesRaw(client, account_id, inbox_id);

      // The listing tool shows whatever an inbox actually returns, including the
      // Meta shape the scheduling tools reject — but says so, so the limitation
      // is discoverable here rather than only at schedule time.
      const note = isMetaShape(payload)
        ? "NOTE: this inbox returns Meta Cloud API templates. The template " +
          "scheduling tools support only Twilio-backed WhatsApp inboxes " +
          "(Channel::TwilioSms) and will reject this inbox.\n\n"
        : "";

      return {
        content: [
          { type: "text", text: note + JSON.stringify(payload, null, 2) },
        ],
      };
    },
  );
};
