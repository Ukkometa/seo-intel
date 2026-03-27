# SEO Intel — Publish Guide
#type/runbook #status/active #project/seo-intel #topic/publishing

> Complete release checklist for shipping a new version of SEO Intel.
> Covers: version bump → git → npm → GitHub Release → Lemon Squeezy zip → website.
> Run this top-to-bottom. Do not skip steps.

---

## Pre-flight

Before touching any version number:

- [ ] All source changes committed and working locally
- [ ] `seo-intel serve` starts without error
- [ ] `seo-intel --help` shows current command list
- [ ] No `froggo.pro` references in source (run check below)
- [ ] No secrets in shipped files (see security scan)

```bash
# Quick branding check
grep -r "froggo.pro" cli.js server.js lib/ crawler/ exports/ reports/ setup/ config/ .env.example README.md LICENSE

# Security scan + exclusion check
bash scripts/publish.sh   # will abort if secrets or moat files found
```

---

## Step 1 — Bump version

Edit `package.json` version field. Follow semver:
- **patch** (1.1.x) — bug fixes, small improvements, branding/copy changes
- **minor** (1.x.0) — new commands, new features, new exports
- **major** (x.0.0) — breaking changes, architecture rewrites

```bash
# Or use npm version (auto-commits + tags):
npm version patch   # or minor / major
```

---

## Step 2 — Update CHANGELOG.md

Add a new entry at the top (below `# Changelog`):

```markdown
## X.X.X (YYYY-MM-DD)

### New Features
- ...

### Improvements
- ...

### Fixes
- ...
```

Keep it human-readable. Bullet points only. No markdown tables.

---

## Step 3 — Git commit + push

```bash
cd ~/Desktop/Spiderbrain/seo-intel

git add -A -- ':!seo-intel-promo/'
git commit -m "chore: bump to vX.X.X — <one-line summary>"
git push
```

> ⚠️ Always exclude `seo-intel-promo/` from git commits (contains marketing assets, not source).

---

## Step 4 — npm publish

```bash
# Use the safe publish script (runs security scan first):
bash scripts/publish.sh

# Or directly (skip scan — not recommended):
npm publish
```

Verify live: https://www.npmjs.com/package/seo-intel

---

## Step 5 — npm pack + build zip

After publishing, create the local tgz and repackage as zip for Lemon Squeezy:

```bash
cd ~/Desktop/Spiderbrain/seo-intel

# Create tgz (1:1 with what npm published)
npm pack

# Unpack and rezip
cd /tmp && rm -rf seo-intel-ls && mkdir seo-intel-ls && cd seo-intel-ls
tar -xzf ~/Desktop/Spiderbrain/seo-intel/seo-intel-X.X.X.tgz
mv package seo-intel
zip -r seo-intel-X.X.X.zip seo-intel/ --exclude "*.DS_Store"
cp seo-intel-X.X.X.zip ~/Desktop/Spiderbrain/seo-intel/
```

The zip is the Lemon Squeezy download artifact. It must:
- Be named `seo-intel-X.X.X.zip`
- Contain a top-level `seo-intel/` folder
- Include `README.md` and `CHANGELOG.md` (they are in `package.json` `files` array)
- NOT contain `node_modules/`, `analysis/`, or `extractor/`

---

## Step 6 — GitHub Release + tag

```bash
cd ~/Desktop/Spiderbrain/seo-intel

# Tag the commit
git tag vX.X.X
git push origin vX.X.X

# Create release with zip attached
gh release create vX.X.X seo-intel-X.X.X.zip \
  --title "vX.X.X" \
  --notes "$(sed -n '/^## X.X.X/,/^## /{ /^## X.X.X/!{ /^## /d }; p }' CHANGELOG.md)"
```

Release URL: `https://github.com/Ukkometa/seo-intel/releases/tag/vX.X.X`

---

## Step 7 — Lemon Squeezy

1. Go to https://app.lemonsqueezy.com
2. Open **SEO Intel** product → **Files**
3. Upload `seo-intel-X.X.X.zip`
4. Remove the old version zip
5. Verify the checkout link still works: https://ukkometa.lemonsqueezy.com/checkout/buy/a00c9eae-03d7-479d-897d-1d2d7aa85937

---

## Step 8 — Website (ukkometa.fi)

The website is a static site deployed manually to Cloudflare Pages.

Files to update when pricing or copy changes:
- `~/Desktop/Spiderbrain/Ukkometa.fi/seo-intel/index.html` — Finnish page
- `~/Desktop/Spiderbrain/Ukkometa.fi/en/seo-intel/index.html` — English page

Both files must always be kept **in sync** (same structure, translated content).

Deploy: drag-drop `~/Desktop/Spiderbrain/Ukkometa.fi/` to Cloudflare Pages dashboard.

---

## Step 9 — ClawHub skill (if skill changed)

If `skill/SKILL.md` changed:

```bash
cd ~/Desktop/Spiderbrain/seo-intel/skill
clawhub publish
```

Verify: https://clawhub.ai/ukkometa/seo-intel

---

## Unified one-liner checklist

```
[ ] scripts/publish.sh            — security scan + npm publish
[ ] npm pack + zip rebuild        — Lemon Squeezy artifact
[ ] git tag vX.X.X + push         — tag the release
[ ] gh release create             — GitHub release + zip attached
[ ] Lemon Squeezy file update     — upload new zip
[ ] Cloudflare Pages deploy       — if website changed
[ ] clawhub publish               — if skill changed
```

---

## Package anatomy (what ships)

Defined in `package.json` → `files` array. Key inclusions:

| Path | Purpose |
|------|---------|
| `cli.js` | Main CLI entry point |
| `server.js` | Dashboard web server |
| `crawler/` | Playwright crawler + stealth |
| `exports/` | Competitive/technical/suggestive exports |
| `lib/` | Gate, license, OAuth, updater |
| `db/db.js` + `db/schema.sql` | SQLite layer |
| `setup/` | Wizard + web routes |
| `reports/` | HTML dashboard generator |
| `README.md` + `CHANGELOG.md` | Docs |
| `.env.example` | Config template |
| Launchers | `.command`, `.bat`, `.sh` |

**Never ships:** `node_modules/`, `analysis/`, `extractor/`, `seo-intel-promo/`, `*.db`, `config/*.json` (user configs), `.env`

---

## CI

GitHub Actions runs on every push to `main`:
- Ubuntu, macOS, Windows
- Installs from source, tests CLI, checks branding, verifies file manifest

Status: https://github.com/Ukkometa/seo-intel/actions

---

*Last updated: 2026-03-27*
