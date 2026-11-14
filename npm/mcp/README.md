# @mojobase/mcp

MCP (Model Context Protocol) server for [Mojobase](https://mojobase.dev). It lets AI coding agents (Claude Code, Cursor, Windsurf, VS Code, Codex, Cline…) work directly with one Mojobase project: read the docs, inspect and change the database schema, run SQL, manage storage buckets and edge functions, read logs and more.

## Install (recommended)

In your project's dashboard on [mojobase.dev](https://mojobase.dev), open **Connect** (or the project home) and copy the install command. It looks like:

```bash
npx @mojobase/install --client claude-code \
  --env API_KEY=ik_your_project_api_key \
  --env API_BASE_URL=https://your-project.mojobase.dev
```

Supported clients: `claude-code`, `cursor`, `windsurf`, `vscode`, `codex`, `cline`, `roocode`, `trae`, `qoder`, `kiro`, `copilot`, `antigravity`, `opencode`.

## Manual configuration

Any MCP client that runs local (stdio) servers:

```json
{
  "mcpServers": {
    "mojobase": {
      "command": "npx",
      "args": ["-y", "@mojobase/mcp@latest"],
      "env": {
        "API_KEY": "ik_your_project_api_key",
        "API_BASE_URL": "https://your-project.mojobase.dev"
      }
    }
  }
}
```

You can also pass them as flags: `npx -y @mojobase/mcp --api_key ik_... --api_base_url https://your-project.mojobase.dev`.

`API_KEY` is the project's admin API key: it has full access to the project, so keep it out of source control.

## Account-level MCP

To let an agent create and manage **all** your projects, use the hosted server instead: `https://mojobase.dev/mcp` with a personal access token from [mojobase.dev/agents](https://mojobase.dev/agents).

## Docs

https://mojobase.dev/docs

## License

Apache-2.0. Based on the open-source InsForge MCP server; see NOTICE.
