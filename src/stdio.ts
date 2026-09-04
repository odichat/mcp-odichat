import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ChatwootClient } from "@/client.ts";
import { createServer } from "@/server.ts";

/**
 * Runs the MCP server over stdio.
 *
 * This is the transport used when an AI client (e.g. Claude Desktop) spawns
 * the server as a local subprocess. The API token is read from the
 * `ODICHAT_API_TOKEN` environment variable.
 */
export async function runStdio(baseUrl: string): Promise<void> {
  const apiToken = process.env.ODICHAT_API_TOKEN;

  if (!apiToken) {
    console.error("ODICHAT_API_TOKEN environment variable is required");
    process.exit(1);
  }

  const client = new ChatwootClient(baseUrl, apiToken);
  const server = createServer(client);
  const transport = new StdioServerTransport();

  await server.connect(transport);
}
