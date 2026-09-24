import { z } from "zod";
import type { RegisterFn } from "@/types.ts";

const accountId = z.number().describe("The account ID");

export const register: RegisterFn = (server, client) => {
  const base = (id: number) => `/api/v1/accounts/${id}/labels`;

  server.registerTool(
    "labels_list",
    {
      title: "List Labels",
      description: "List all labels defined in the account",
      inputSchema: { account_id: accountId },
      annotations: { readOnlyHint: true },
    },
    async ({ account_id }) => {
      const result = await client.get(base(account_id));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "labels_create",
    {
      title: "Create Label",
      description:
        "Create a label in the account so it can be applied to conversations and contacts",
      inputSchema: {
        account_id: accountId,
        title: z.string().describe("Label name (lowercase, no spaces)"),
        description: z.string().optional().describe("Label description"),
        color: z.string().optional().describe("Label color (hex)"),
        show_on_sidebar: z
          .boolean()
          .optional()
          .describe("Show the label in the sidebar"),
      },
    },
    async ({ account_id, ...body }) => {
      const result = await client.post(base(account_id), { label: body });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "labels_update",
    {
      title: "Update Label",
      description: "Update an existing label",
      inputSchema: {
        account_id: accountId,
        id: z.number().describe("Label ID"),
        title: z.string().optional().describe("Label name"),
        description: z.string().optional().describe("Label description"),
        color: z.string().optional().describe("Label color (hex)"),
        show_on_sidebar: z
          .boolean()
          .optional()
          .describe("Show the label in the sidebar"),
      },
      annotations: { idempotentHint: true },
    },
    async ({ account_id, id, ...body }) => {
      const result = await client.patch(`${base(account_id)}/${id}`, {
        label: body,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "labels_delete",
    {
      title: "Delete Label",
      description:
        "Delete a label and remove it from every conversation and contact that carries it",
      inputSchema: {
        account_id: accountId,
        id: z.number().describe("Label ID"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ account_id, id }) => {
      await client.delete(`${base(account_id)}/${id}`);
      return {
        content: [{ type: "text", text: "Label deleted successfully" }],
      };
    },
  );
};
