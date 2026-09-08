import { z } from "zod";
import {
  fetchTwilioTemplates,
  findApprovedTemplate,
  resolveInboxId,
  scheduleTemplateMessage,
} from "@/templates.ts";
import { formatLocalTime, isValidIanaZone, zonedToUtc } from "@/time.ts";
import type { RegisterFn } from "@/types.ts";

/** Sent an hour before the call. Skipped when booked on less notice. */
const REMINDER_TEMPLATE = "call_reminder_1h";
/** Sent at the call time itself. */
const ONGOING_TEMPLATE = "call_ongoing_now";

const ONE_HOUR_MS = 60 * 60 * 1000;

export const register: RegisterFn = (server, client) => {
  server.registerTool(
    "scheduled_messages_create_call_reminders",
    {
      title: "Schedule Call Reminders",
      description:
        "[Odichat] Schedule the two WhatsApp call reminders for a booked call: " +
        `"${REMINDER_TEMPLATE}" one hour before, and "${ONGOING_TEMPLATE}" at ` +
        "the call time. Give the call time as a naive local time plus an IANA " +
        "timezone; the tool converts to UTC. The no-show follow-up is not " +
        "scheduled — a human sends that one manually.",
      inputSchema: {
        account_id: z.number().describe("The account ID"),
        conversation_id: z.number().describe("Conversation ID (display_id)"),
        call_time_local: z
          .string()
          .describe(
            "Local wall-clock time of the call as YYYY-MM-DDTHH:mm, with no " +
              "offset and no trailing Z (e.g. 2026-09-09T10:00)",
          ),
        iana_timezone: z
          .string()
          .describe(
            "IANA timezone identifier for the local time, e.g. America/Caracas. " +
              "Translate the contact's country or city into an identifier before " +
              "calling; this tool validates but does not guess.",
          ),
      },
    },
    async ({ account_id, conversation_id, call_time_local, iana_timezone }) => {
      if (!isValidIanaZone(iana_timezone)) {
        throw new Error(
          `"${iana_timezone}" is not a valid IANA timezone identifier. ` +
            `Use a full identifier such as America/Caracas or Europe/Madrid, ` +
            `not a country, city or abbreviation.`,
        );
      }

      const callAt = zonedToUtc(call_time_local, iana_timezone);
      if (callAt.getTime() <= Date.now()) {
        throw new Error(
          `The call time ${call_time_local} (${iana_timezone}) is ` +
            `${callAt.toISOString()}, which is in the past. ` +
            `Reminders can only be scheduled for a future call.`,
        );
      }

      // {{2}} is the call time as the contact will read it, so it is formatted
      // in their own timezone, not UTC.
      const localLabel = formatLocalTime(callAt, iana_timezone);
      const extraParams = { "2": localLabel };

      // Resolve the inbox and templates once — both messages share them, which
      // is what the per-client template cache is for.
      const inboxId = await resolveInboxId(client, account_id, conversation_id);
      const templates = await fetchTwilioTemplates(client, account_id, inboxId);
      const reminder = findApprovedTemplate(templates, REMINDER_TEMPLATE);
      const ongoing = findApprovedTemplate(templates, ONGOING_TEMPLATE);

      const lines: string[] = [];
      const remindAt = new Date(callAt.getTime() - ONE_HOUR_MS);

      // Scheduled in chronological order.
      if (remindAt.getTime() > Date.now()) {
        const result = await scheduleTemplateMessage(client, {
          accountId: account_id,
          conversationId: conversation_id,
          template: reminder,
          scheduledAt: remindAt,
          extraParams,
        });
        lines.push(
          `Scheduled "${REMINDER_TEMPLATE}" for ${remindAt.toISOString()} ` +
            `(id ${result.id}).`,
        );
      } else {
        // Expected whenever a call is booked on under an hour's notice — a
        // skipped reminder is a normal outcome, not a failure.
        lines.push(
          `Skipped "${REMINDER_TEMPLATE}": one hour before the call is ` +
            `${remindAt.toISOString()}, which has already passed.`,
        );
      }

      const ongoingResult = await scheduleTemplateMessage(client, {
        accountId: account_id,
        conversationId: conversation_id,
        template: ongoing,
        scheduledAt: callAt,
        extraParams,
      });
      lines.push(
        `Scheduled "${ONGOING_TEMPLATE}" for ${callAt.toISOString()} ` +
          `(id ${ongoingResult.id}).`,
      );

      return {
        content: [
          {
            type: "text",
            text:
              `Call at ${localLabel} local time (${iana_timezone}) = ` +
              `${callAt.toISOString()}.\n\n${lines.join("\n")}`,
          },
        ],
      };
    },
  );
};
