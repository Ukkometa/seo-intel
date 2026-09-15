# Hermes integration

`hermes/seo-intel/` is an **Agent Plugins v1** package, so Hermes installs SEO Intel straight from GitHub and detects both halves. It is a folder of its own rather than the repository root on purpose: Hermes security-scans the whole plugin root at install time, and the crawler codebase (browser automation, subprocesses, SQL) would be flagged and blocked. The package folder contains only what Hermes needs:

- **Agent half** — `plugin.json`, `mcp.json`, `skills/seo-intel/` (mirrored from `skill/` by `scripts/sync-plugin.js`). Registers the SEO Intel skill and the MCP server (`npx -y seo-intel-mcp`) with the Hermes agent.
- **Desktop half** — `desktop/plugin.js`. A Search Review pane and a status-bar chip in Hermes Desktop.
- **Backend** — `dashboard/manifest.json` + `dashboard/plugin_api.py`. Mounted at `/api/plugins/seo-intel/`; the pane reads it through `ctx.rest`. It shells out to the local `seo-intel` CLI and never writes to SEO Intel's data.

It is intentionally generic: no personal project names, no hardcoded checkout paths, no secrets or license keys. SEO Intel stays the read-only intelligence layer; Hermes stays the execution layer that turns findings into agent tasks.

## Install

Any one of these:

```bash
# Hermes Desktop: Capabilities → Plugins → Install from Git, paste
https://github.com/Ukkometa/seo-intel/tree/main/hermes/seo-intel

# Hermes CLI
hermes plugins install Ukkometa/seo-intel/hermes/seo-intel --enable

# From an npm install of seo-intel (same files, no network)
seo-intel hermes install
```

Then:

1. `hermes plugins enable seo-intel` if you did not pass `--enable`. Portable packages install disabled by default.
2. In Hermes Desktop, switch the desktop half on under **Capabilities → Plugins** (the desktop half of a package ships opt-in).
3. The **Search Review** pane appears on the right. Pick a project; the chip in the status bar shows how many decisions wait on you.

A one-click link for a website or README: `hermes://plugin/install?repo=Ukkometa/seo-intel/hermes/seo-intel`.

The plain repository URL will not do: Hermes looks for the manifest at the root of whatever it clones, and the root here is the npm package.

## Runtime resolution

The backend finds the SEO Intel CLI in this order:

1. `SEO_INTEL_ROOT` or `HERMES_SEO_INTEL_ROOT`
2. `~/.seo-intel/install.json`, written by every `seo-intel` CLI run
3. `seo-intel` on `PATH`
4. `npx seo-intel`

The MCP server started by Hermes (`npx -y seo-intel-mcp`) shares the CLI's database through the same registry, so the agent, the pane, and the dashboard all read one store.

## Backend routes

| Route | What it returns |
|---|---|
| `GET /projects` | Configured projects with target URL and source path |
| `GET /review?project=&url=&limit=` | Search Review: `needs_input`, `safe_now`, `opportunities`, `working`, `freshness` |
| `GET /intel?project=&for=audit` | The intel slice, summarised for the cockpit |
| `GET /rescore?project=&url=` | Before/after citability for one URL |
| `POST /agent-task` | Turn one finding into a Hermes agent brief (stored under `plugin-data/seo-intel/`) |
| `GET /agent-tasks` · `POST /agent-task/status` | The task queue |
