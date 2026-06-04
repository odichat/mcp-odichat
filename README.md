# mcp-odichat

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that exposes the full [Odichat](https://odichat.app) API as tools for use with AI assistants like Claude, ChatGPT, VS Code Copilot, and others.

## Features

- Account, Agents, Contacts, Conversations, Messages, Inboxes, Teams, and more
- Reports (v1 & v2), Help Center, Automation Rules, Custom Attributes, Custom Filters
- Proper MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`)
- Multi-account support (`account_id` is a per-tool argument)
- Two transports:
  - **stdio** — local subprocess (Claude Desktop, VS Code, and any MCP client)
  - **Streamable HTTP** — remote, hosted server (Claude Web/Desktop/Code, ChatGPT). Stateless; the API token is passed per request via a `?token=` query param

## Requirements

- [Bun](https://bun.sh/) v1.0+
- An Odichat instance with API access

## Installation

```bash
bun install
```

## Environment Variables

| Variable            | Required        | Description                                                                                    |
| ------------------- | --------------- | ---------------------------------------------------------------------------------------------- |
| `ODICHAT_API_TOKEN` | stdio only      | API access token (found in Odichat → Profile → Access Token). Not used by the HTTP transport.  |
| `MCP_TRANSPORT`     | No              | Set to `http` to run as a network server. Any other value (or unset) uses stdio.               |
| `PORT`              | No              | Port for the HTTP transport. Defaults to `3000`.                                               |

> In HTTP mode the token is **not** read from the environment — each client supplies its own token via the `?token=` query param, keeping the server stateless and multi-tenant.

## Usage

### Development

```bash
bun run dev
```

### Production (stdio)

```bash
bun run start
```

### Production (remote HTTP server)

Run the server over HTTP with `Bun.serve()` and the web-standard Streamable HTTP transport:

```bash
MCP_TRANSPORT=http PORT=3000 bun run src/index.ts
```

Or with Docker:

```bash
docker build -t mcp-odichat .
docker run -p 3000:3000 mcp-odichat
```

The server is stateless — no database, no sessions. Each request must include the
caller's Odichat API token as a `?token=` query param. SSL is expected to be
terminated by an upstream proxy (e.g. Traefik).

Endpoints:

| Method        | Path      | Description                                  |
| ------------- | --------- | -------------------------------------------- |
| `POST`/`GET`  | `/mcp`    | MCP Streamable HTTP endpoint                 |
| `GET`         | `/health` | Health check (returns `ok`)                  |

## Connecting to a hosted server

Point any remote-MCP-capable client (Claude Web/Desktop/Code, ChatGPT) at the
server URL with your token in the query string:

```
https://mcp.odichat.app/mcp?token=YOUR_API_TOKEN
```

1. In Odichat, go to **Profile → Access Token** and copy your token.
2. Add the URL above (with your token) as the MCP server URL in your AI client.

## Local (stdio) client configuration

### Claude Desktop Configuration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "odichat": {
      "command": "bun",
      "args": ["run", "/path/to/mcp-odichat/src/index.ts"],
      "env": {
        "ODICHAT_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### VS Code Configuration

Add to your `.vscode/mcp.json`:

```json
{
  "servers": {
    "odichat": {
      "command": "bun",
      "args": ["run", "${workspaceFolder}/src/index.ts"],
      "env": {
        "ODICHAT_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### ChatGPT Configuration

ChatGPT connects to remote MCP servers over HTTP — see
[Connecting to a hosted server](#connecting-to-a-hosted-server) above.

## Available Tools

### Account (2)

`account_get`, `account_update`

### Agent Bots (5)

`agent_bots_list`, `agent_bots_create`, `agent_bots_get`, `agent_bots_update`, `agent_bots_delete`

### Agents (4)

`agents_list`, `agents_create`, `agents_update`, `agents_delete`

### Audit Logs (1)

`audit_logs_list`

### Automation Rules (5)

`automation_rules_list`, `automation_rules_create`, `automation_rules_get`, `automation_rules_update`, `automation_rules_delete`

### Canned Responses (4)

`canned_responses_list`, `canned_responses_create`, `canned_responses_update`, `canned_responses_delete`

### Contacts (11)

`contacts_list`, `contacts_create`, `contacts_get`, `contacts_update`, `contacts_delete`, `contacts_conversations`, `contacts_search`, `contacts_filter`, `contacts_create_contact_inbox`, `contacts_contactable_inboxes`, `contacts_merge`

### Contact Labels (2)

`contact_labels_list`, `contact_labels_set`

### Conversations (12)

`conversations_meta`, `conversations_list`, `conversations_create`, `conversations_filter`, `conversations_get`, `conversations_update`, `conversations_toggle_status`, `conversations_toggle_priority`, `conversations_set_custom_attributes`, `conversations_get_labels`, `conversations_set_labels`, `conversations_reporting_events`

### Conversation Assignments (1)

`conversation_assignments_assign`

### Messages (3)

`messages_list`, `messages_create`, `messages_delete`

### Custom Attributes (5)

`custom_attributes_list`, `custom_attributes_create`, `custom_attributes_get`, `custom_attributes_update`, `custom_attributes_delete`

### Custom Filters (5)

`custom_filters_list`, `custom_filters_create`, `custom_filters_get`, `custom_filters_update`, `custom_filters_delete`

### Help Center (5)

`help_center_portals_list`, `help_center_portals_create`, `help_center_portals_update`, `help_center_categories_create`, `help_center_articles_create`

### Inboxes (10)

`inboxes_list`, `inboxes_get`, `inboxes_create`, `inboxes_update`, `inboxes_get_agent_bot`, `inboxes_set_agent_bot`, `inbox_members_list`, `inbox_members_create`, `inbox_members_update`, `inbox_members_delete`

### Integrations (4)

`integrations_list_apps`, `integrations_create_hook`, `integrations_update_hook`, `integrations_delete_hook`

### Profile (1)

`profile_get`

### Reports (9)

`reports_account_overview`, `reports_account_summary`, `reports_agent_summary`, `reports_conversation_metrics`, `reports_v2_overview`, `reports_v2_agents`, `reports_v2_inboxes`, `reports_v2_teams`, `reports_v2_labels`

### Teams (9)

`teams_list`, `teams_create`, `teams_get`, `teams_update`, `teams_delete`, `team_members_list`, `team_members_add`, `team_members_update`, `team_members_delete`

### Webhooks (4)

`webhooks_list`, `webhooks_create`, `webhooks_update`, `webhooks_delete`

## Development

```bash
# Run tests
bun test

# Lint & format
bun run lint
bun run format

# Type check
bun run build-check

# Full check (lint + type-check + tests)
bun run check
```

## License

MIT
