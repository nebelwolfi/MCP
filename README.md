# Claude Utils

A collection of utilities for use with Claude Code.

## Install

Run this in PowerShell (no cloning needed):

```powershell
irm https://raw.githubusercontent.com/nebelwolfi/claude-utils/master/install.ps1 | iex
```

This will:
1. Clone the repo to `~/.claude-utils` (or pull if it already exists)
2. Run `npm install` for each MCP server
3. Register each MCP server with `claude mcp add --scope user`

To install to a custom directory:

```powershell
iex "& { $(irm https://raw.githubusercontent.com/nebelwolfi/claude-utils/master/install.ps1) } -InstallDir 'C:\your\path'"
```

## Update

Re-run the same command — it pulls the latest and re-registers any new servers.

## Verify

```powershell
claude mcp list
```

## Tools

| Name | Description |
|------|-------------|
| kanban-mcp | Kanban board MCP server |
