# Hermes Desktop integration

This directory contains the distributable SEO Intel → Hermes integration.

It is intentionally generic:

- no personal project names
- no hardcoded checkout paths
- no secrets or license keys
- SEO Intel remains the read-only intelligence/evidence layer
- Hermes remains the execution layer that turns findings into tasks/agent prompts

## Runtime resolution

The backend resolves the SEO Intel CLI in this order:

1. `SEO_INTEL_ROOT` or `HERMES_SEO_INTEL_ROOT` environment variable
2. `~/.seo-intel/install.json`, written by every `seo-intel` CLI run
3. `seo-intel` on `PATH`
4. `npx seo-intel`

That makes the plugin work for both npm-installed customers and source-checkout developers.

## Files

```text
hermes/seo-intel/dashboard/manifest.json
hermes/seo-intel/dashboard/plugin_api.py
```

`manifest.json` also carries the desired Desktop sidebar shape in `desktop.sidebar`.
Current Hermes builds may still need a Desktop source hook to consume that manifest field; once Hermes supports plugin-provided sidebar entries, this bundle is the source of truth.

## Install from an SEO Intel checkout

```bash
seo-intel hermes install
```

This copies the plugin bundle into:

```text
~/.hermes/plugins/seo-intel/dashboard/
```

Then enable/restart Hermes as needed:

```bash
hermes plugins enable seo-intel
hermes desktop --force-build
```
