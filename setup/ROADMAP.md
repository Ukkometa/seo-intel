# SEO Intel Setup — Roadmap

> From open-source CLI tool → standalone product

## Current State (v0.2)
- [x] System detection (Node, npm, Ollama, Playwright, VRAM)
- [x] Model recommendations (VRAM-based extraction + analysis tiers)
- [x] Project configuration (target domain, competitors, crawl mode)
- [x] API key setup (Gemini, Claude, OpenAI, DeepSeek)
- [x] Pipeline validation (Ollama → API → crawl → extraction)
- [x] CLI wizard + Web wizard at /setup
- [x] GSC setup step (CSV upload + export guide + auto-detection)
- [x] License system (lib/license.js + lib/gate.js)
- [x] Free/Pro tier gating on all 23 CLI commands
- [x] Page limit enforcement (500/domain on free tier)
- [x] License status in `status` command

## Priority 1 — GSC Setup Guide
**Status: ✅ Done (CSV upload, export guide, auto-detection)**

Google Search Console is the #1 data source users need but can't figure out alone.
Currently: manual CSV export, no API, no guidance in wizard.

- [ ] Add Step 3.5: "Connect Google Search Console" in web wizard
- [ ] Visual walkthrough: how to export CSVs from GSC UI (screenshots/steps)
- [ ] Auto-detect existing GSC data in `gsc/` folder
- [ ] GSC API integration (service account JSON key upload)
- [ ] Auto-fetch GSC data on schedule (replaces manual CSV)

## Priority 2 — Ollama Auto-Install
**Status: 📋 Planned**

If Ollama isn't found, offer to install it instead of just warning.

- [ ] macOS: `brew install ollama` or direct download
- [ ] Linux: `curl -fsSL https://ollama.com/install.sh | sh`
- [ ] Windows: direct user to installer URL
- [ ] Auto-start Ollama after install
- [ ] Auto-pull recommended model after install

## Priority 3 — Scheduling / Automation
**Status: 📋 Planned**

After setup, users need recurring crawls. "Set and forget."

- [ ] "Schedule weekly crawl?" step in wizard
- [ ] Cron job generator (macOS launchd / Linux cron / Windows Task Scheduler)
- [ ] Built-in scheduler (node-cron or setTimeout loop in server.js)
- [ ] Crawl → Extract → Analyze → Regenerate dashboard pipeline
- [ ] "Last run" / "Next run" display on dashboard

## Priority 4 — First Run Experience
**Status: 📋 Planned**

Don't just show CLI commands — offer to run the first crawl right there.

- [ ] "Run your first crawl now?" button on Step 5
- [ ] SSE progress stream showing crawl progress in real-time
- [ ] Auto-trigger extraction + analysis after crawl
- [ ] Redirect to dashboard when done
- [ ] Estimated time based on competitor count × pages per domain

## Priority 5 — Proxy & Rate Limiting
**Status: 📋 Planned**

Stealth mode users need proxy config to avoid blocks.

- [ ] Proxy URL input (HTTP/SOCKS5)
- [ ] Proxy rotation list upload
- [ ] Rate limit slider (requests/minute)
- [ ] Per-domain delay configuration
- [ ] "Test proxy" validation step

## Priority 6 — Notifications
**Status: 📋 Planned**

Know when things happen without checking manually.

- [ ] Email notifications (SMTP setup in wizard)
- [ ] Slack webhook integration
- [ ] Discord webhook integration
- [ ] Configurable triggers: crawl complete, ranking drop, new competitor page
- [ ] Weekly digest email with key metrics

## Priority 7 — Data & Backup
**Status: 📋 Planned**

Where data lives, how big it gets, how to manage it.

- [ ] Show data directory + size in dashboard footer
- [ ] One-click export (SQLite → JSON/CSV)
- [ ] Auto-backup before major operations
- [ ] Data retention settings (keep last N crawls)
- [ ] Cloud backup option (S3/GCS)

---

## Open Source → Product Progression

| Feature | Open Source (froggo.pro) | Standalone SaaS |
|---------|------------------------|-----------------|
| Setup | CLI wizard | Web wizard + onboarding email |
| Auth | None (local) | User accounts + API keys |
| GSC | Manual CSV or API key | OAuth "Connect GSC" button |
| Scheduling | Cron jobs | Built-in + hosted workers |
| Notifications | Webhook only | Email + Slack + in-app |
| Data | Local SQLite | Cloud DB + CDN dashboards |
| Multi-user | Single | Teams + permissions |
| Billing | Free / one-time | Subscription tiers |
