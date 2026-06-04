import { runHttp } from "@/http.ts";
import { runStdio } from "@/stdio.ts";

// All customers share the same Odichat instance, so the base URL is hardcoded.
const baseUrl = "https://portal.odichat.app";

// Transport selection:
//   MCP_TRANSPORT=http  → run as a network server (Bun.serve + Streamable HTTP)
//   otherwise           → run over stdio (local subprocess, e.g. Claude Desktop)
if (process.env.MCP_TRANSPORT === "http") {
  runHttp(baseUrl);
} else {
  await runStdio(baseUrl);
}
