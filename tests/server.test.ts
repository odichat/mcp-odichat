import { describe, expect, test } from "bun:test";
import { ChatwootClient } from "@/client.ts";
import { createServer } from "@/server.ts";

describe("Server", () => {
  test("creates server with all tools registered", () => {
    const client = new ChatwootClient(
      "https://chatwoot.example.com",
      "test-token",
    );
    const server = createServer(client);

    // The server should have been created successfully
    expect(server).toBeDefined();
  });

  test("registers all tools", () => {
    const client = new ChatwootClient(
      "https://chatwoot.example.com",
      "test-token",
    );
    const server = createServer(client);

    // biome-ignore lint/suspicious/noExplicitAny: accessing internal properties for testing
    const tools = (server as any)._registeredTools;
    expect(Object.keys(tools).length).toBe(100);
  });
});
