# @mojobase/install

Installs the [Mojobase](https://mojobase.dev) MCP server (`@mojobase/mcp`) into your AI coding agent, so it can work directly with your Mojobase project.

```bash
npx @mojobase/install --client <client> \
  --env API_KEY=ik_your_project_api_key \
  --env API_BASE_URL=https://your-project.mojobase.dev
```

Copy the exact command (with your keys filled in) from your project's **Connect** panel on [mojobase.dev](https://mojobase.dev).

| `--client` | Agent |
|---|---|
| `claude-code` | Claude Code |
| `cursor` | Cursor |
| `windsurf` | Windsurf |
| `cline` | Cline |
| `roocode` | Roo Code |
| `codex` | Codex |
| `copilot` | GitHub Copilot (VS Code) |
| `trae` | Trae |
| `qoder` | Qoder |
| `kiro` | Kiro |
| `antigravity` | Antigravity |
| `opencode` | OpenCode |

Restart your agent afterwards. Add `--dev` to install the pre-release MCP server.

Docs: https://mojobase.dev/docs

## License

MIT. Based on the InsForge MCP installer.
