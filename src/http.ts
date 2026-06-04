import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ChatwootClient } from "@/client.ts";
import { createServer } from "@/server.ts";

/**
 * JSON-RPC error response helper for connection-level failures (e.g. a missing
 * token) that happen before a transport is established.
 */
function jsonRpcError(code: number, message: string, status: number): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status },
  );
}

/**
 * Runs the MCP server over HTTP using `Bun.serve()` and the web-standard
 * Streamable HTTP transport.
 *
 * The server is fully stateless: each customer passes their Odichat API token
 * as a `?token=` query parameter, and a fresh per-request MCP server + transport
 * are created bound to that token. There is no session store or database.
 *
 *     https://mcp.odichat.app/mcp?token=THEIR_API_TOKEN
 *
 * The Odichat base URL is shared by all customers, so it is passed in once.
 */
export function runHttp(baseUrl: string): void {
  const port = Number(process.env.PORT ?? 3000);

  Bun.serve({
    port,
    // SSE response streams can stay open longer than the default; disable the
    // idle timeout so streaming responses aren't cut off.
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);

      // Lightweight health check for load balancers / container orchestration.
      if (url.pathname === "/health") {
        return new Response("ok");
      }

      // The token is supplied per request via the URL query param. We are not
      // implementing OAuth — customers copy their token from Odichat
      // (Profile → Access Token) and embed it in the MCP URL.
      const token = url.searchParams.get("token");
      if (!token) {
        return jsonRpcError(-32001, "Missing ?token= query parameter", 401);
      }

      const client = new ChatwootClient(baseUrl, token);
      const server = createServer(client);
      const transport = new WebStandardStreamableHTTPServerTransport({
        // Stateless mode — no session IDs, no in-memory session store.
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);
      return transport.handleRequest(req);
    },
  });

  // Logged to stderr so it never interferes with stdio transport consumers.
  console.error(`Odichat MCP server listening on http://0.0.0.0:${port}`);
}
