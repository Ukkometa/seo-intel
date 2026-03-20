#!/usr/bin/env node
/**
 * seo-audit <url>
 * On-demand SEO audit for any URL — Ahrefs toolbar style.
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import fetch from 'node-fetch';
import chalk from 'chalk';

const url = process.argv[2];
const jsonMode = process.argv.includes("--json");
const reportMode = process.argv.includes("--report");

if (!url) {
  console.error('Usage: node seo-audit.js <url> [--json]');
  process.exit(1);
}

const ok   = (t) => chalk.green('✅ ' + t);
const warn = (t) => chalk.yellow('⚠️  ' + t);
const fail = (t) => chalk.red('❌ ' + t);
const info = (t) => chalk.cyan('   ↳ ' + t);
const dim  = (t) => chalk.gray('   ' + t);
const head = (t) => chalk.bold.white('\n' + t);

function titleLen(t) {
  if (!t) return { status: 'fail', label: 'Missing' };
  const l = t.length;
  if (l < 30)  return { status: 'warn', label: `Too short (${l}/60)` };
  if (l > 60)  return { status: 'warn', label: `Too long (${l}/60)` };
  return { status: 'ok', label: `${l}/60` };
}

function descLen(t) {
  if (!t) return { status: 'fail', label: 'Missing' };
  const l = t.length;
  if (l < 50)  return { status: 'warn', label: `Too short (${l}/160)` };
  if (l > 160) return { status: 'warn', label: `Too long (${l}/160)` };
  return { status: 'ok', label: `${l}/160` };
}

function renderStatus(s, label) {
  if (s === 'ok')   return ok(label);
  if (s === 'warn') return warn(label);
  return fail(label);
}

function checkHeadingOrder(headings) {
  const issues = [];
  if (headings.length === 0) return { ok: false, issues: ['No headings found'] };
  if (headings[0].level !== 1) issues.push(`First heading is H${headings[0].level}, not H1`);
  for (let i = 1; i < headings.length; i++) {
    if (headings[i].level > headings[i-1].level + 1) {
      issues.push(`H${headings[i-1].level} → H${headings[i].level} skip near "${headings[i].text.slice(0,40)}"`);
    }
  }
  return { ok: issues.length === 0, issues };
}

async function checkUrl(u) {
  try {
    const res = await fetch(u, { method: 'HEAD', redirect: 'follow' }).catch(() => null);
    return res?.ok ? 'ok' : 'fail';
  } catch { return 'fail'; }
}

async function fetchRaw(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    redirect: 'follow',
  });
  const html = await res.text();
  return { html, status: res.status, finalUrl: res.url };
}

function parseRawHtml(html) {
  const schemas = [];
  const schemaRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = schemaRe.exec(html)) !== null) {
    try { schemas.push(JSON.parse(m[1])); } catch {}
  }

  const og = {};
  const ogRe = /<meta[^>]+property=["'](og:[^"']+)["'][^>]+content=["']([^"']*)["'][^>]*>/gi;
  while ((m = ogRe.exec(html)) !== null) og[m[1]] = m[2];
  // also try reversed attr order
  const ogRe2 = /<meta[^>]+content=["']([^"']*)["'][^>]+property=["'](og:[^"']+)["'][^>]*>/gi;
  while ((m = ogRe2.exec(html)) !== null) og[m[2]] = m[1];

  const twitter = {};
  const twRe = /<meta[^>]+name=["'](twitter:[^"']+)["'][^>]+content=["']([^"']*)["'][^>]*>/gi;
  while ((m = twRe.exec(html)) !== null) twitter[m[1]] = m[2];
  const twRe2 = /<meta[^>]+content=["']([^"']*)["'][^>]+name=["'](twitter:[^"']+)["'][^>]*>/gi;
  while ((m = twRe2.exec(html)) !== null) twitter[m[2]] = m[1];

  const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i)
    || html.match(/<link[^>]+href=["']([^"']*)["'][^>]+rel=["']canonical["']/i);
  const canonical = canonicalMatch?.[1] || null;

  const robotsMatch = html.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i);
  const robotsMeta = robotsMatch?.[1] || null;

  const imgRe = /<img([^>]*)>/gi;
  const images = [];
  while ((m = imgRe.exec(html)) !== null) {
    const attrs = m[1];
    const altMatch = attrs.match(/alt=["']([^"']*)["']/i);
    const srcMatch = attrs.match(/src=["']([^"']*)["']/i);
    images.push({ src: srcMatch?.[1] || '', alt: altMatch ? altMatch[1] : null });
  }

  const hasFaq = html.toLowerCase().includes('faq') ||
    schemas.some(s => s['@type'] === 'FAQPage') ||
    html.toLowerCase().includes('frequently asked');

  return { schemas, og, twitter, canonical, robotsMeta, images, hasFaq };
}

async function crawlPage(url) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; SEOAuditBot/1.0)',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  try {
    const t0 = Date.now();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const loadMs = Date.now() - t0;
    const status = res?.status() || 0;

    const title    = await page.title().catch(() => '');
    const metaDesc = await page.$eval('meta[name="description"]', el => el.content).catch(() => '');

    const headings = await page.$$eval('h1,h2,h3,h4,h5,h6', els =>
      els.map(el => ({ level: parseInt(el.tagName[1]), text: el.innerText?.trim().slice(0, 120) }))
         .filter(h => h.text)
    ).catch(() => []);

    const wordCount = await page.$eval('body', el =>
      el.innerText.split(/\s+/).filter(Boolean).length
    ).catch(() => 0);

    const base = new URL(url);
    const allLinks = await page.$$eval('a[href]', (els, baseHref) =>
      els.map(el => {
        try { return { href: new URL(el.href, baseHref).href, anchor: el.innerText?.trim().slice(0, 80) || '' }; }
        catch { return null; }
      }).filter(Boolean), base.href
    ).catch(() => []);

    const internalLinks = allLinks.filter(l => { try { return new URL(l.href).hostname === base.hostname; } catch { return false; } });
    const externalLinks = allLinks.filter(l => { try { return new URL(l.href).hostname !== base.hostname; } catch { return false; } });

    const publishedDate = await page.evaluate(() => {
      for (const sel of ['meta[property="article:published_time"]','meta[name="date"]','meta[itemprop="datePublished"]']) {
        const el = document.querySelector(sel); if (el?.content) return el.content;
      }
      for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { const d = JSON.parse(el.textContent); if (d.datePublished) return d.datePublished; } catch {}
      }
      return null;
    }).catch(() => null);

    const modifiedDate = await page.evaluate(() => {
      for (const sel of ['meta[property="article:modified_time"]','meta[name="last-modified"]','meta[itemprop="dateModified"]']) {
        const el = document.querySelector(sel); if (el?.content) return el.content;
      }
      for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { const d = JSON.parse(el.textContent); if (d.dateModified) return d.dateModified; } catch {}
      }
      return null;
    }).catch(() => null);

    return { status, loadMs, title, metaDesc, headings, wordCount, internalLinks, externalLinks, publishedDate, modifiedDate };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function audit(rawUrl) {
  const parsedUrl = new URL(rawUrl);
  const origin = parsedUrl.origin;

  if (!jsonMode) process.stdout.write(chalk.gray('Auditing... (this takes ~10s)\n'));

  const [raw, rendered, sitemapStatus, robotsStatus] = await Promise.all([
    fetchRaw(rawUrl),
    crawlPage(rawUrl),
    checkUrl(`${origin}/sitemap.xml`),
    checkUrl(`${origin}/robots.txt`),
  ]);

  const { schemas, og, twitter, canonical, robotsMeta, images, hasFaq } = parseRawHtml(raw.html);
  const { status, loadMs, title, metaDesc, headings, wordCount, internalLinks, externalLinks, publishedDate, modifiedDate } = rendered;

  const schemaTypes  = schemas.map(s => s['@type']).filter(Boolean);
  const missingAlt   = images.filter(i => i.alt === null || i.alt === '').length;
  const headingCheck = checkHeadingOrder(headings);
  const titleInfo    = titleLen(title);
  const descInfo     = descLen(metaDesc);
  const isIndexable  = !robotsMeta?.toLowerCase().includes('noindex');

  if (jsonMode) {
    console.log(JSON.stringify({ url: rawUrl, status, loadMs, title, metaDesc, headings, wordCount, canonical, robotsMeta, isIndexable, sitemapFound: sitemapStatus === 'ok', robotsFound: robotsStatus === 'ok', schemaTypes, hasFaq, og, twitter, images: { total: images.length, missingAlt }, internalLinks: internalLinks.length, externalLinks: externalLinks.length, publishedDate, modifiedDate }, null, 2));
    return;
  }

  console.log(chalk.bold(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
  console.log(chalk.bold.white(`  🔍 SEO Audit — ${rawUrl}`));
  console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));

  // CONTENT
  console.log(head('📄  CONTENT'));
  console.log(renderStatus(titleInfo.status, `Meta Title — ${titleInfo.label}`));
  if (title) console.log(dim(`"${title.slice(0, 70)}"`));
  if (titleInfo.status === 'fail') console.log(info('Title is your #1 ranking signal. Missing = Google writes one for you (badly).'));
  if (titleInfo.status === 'warn' && title.length > 60) console.log(info('Google truncates titles over 60 chars. Shorter = full display in search results.'));
  if (titleInfo.status === 'warn' && title.length < 30) console.log(info('Short titles miss keyword opportunities. Aim 50-60 chars to fill the snippet.'));

  console.log(renderStatus(descInfo.status, `Meta Description — ${descInfo.label}`));
  if (metaDesc) console.log(dim(`"${metaDesc.slice(0, 90)}..."`));
  if (descInfo.status === 'fail') console.log(info('No description = Google pulls random page text. Write one to control your snippet.'));
  if (descInfo.status === 'warn' && metaDesc.length > 160) console.log(info('Truncated at ~160 chars. Your CTA at the end may get cut off.'));

  console.log(publishedDate ? ok(`Published Date — ${publishedDate}`) : warn('Published Date — Missing'));
  if (!publishedDate) console.log(info('Published date signals freshness. Helps content rank for recency queries.'));

  console.log(modifiedDate ? ok(`Modified Date — ${modifiedDate}`) : warn('Modified Date — Missing'));
  if (!modifiedDate) console.log(info('Updated date tells Google content is maintained. Important for competitive queries.'));

  const wcStatus = wordCount >= 600 ? 'ok' : wordCount >= 300 ? 'warn' : 'fail';
  console.log(renderStatus(wcStatus, `Word Count — ${wordCount.toLocaleString()} words`));
  if (wcStatus === 'warn') console.log(info('300-600 words is thin. Competitors with deeper content tend to outrank on informational queries.'));
  if (wcStatus === 'fail') console.log(info('Under 300 words. Google may flag as thin content. Add FAQ, features, or use cases.'));

  // HEADINGS
  console.log(head('📑  HEADINGS'));
  console.log(headingCheck.ok ? ok('Heading structure correct') : warn('Heading structure issues detected'));
  for (const issue of headingCheck.issues) console.log(info(issue));
  if (!headingCheck.ok) console.log(info('H1→H2→H3 order helps Google understand hierarchy and boosts content relevance.'));
  const topH = headings.slice(0, 6);
  if (topH.length) {
    console.log(dim('First 6 headings:'));
    for (const h of topH) console.log(chalk.gray(`   ${'  '.repeat(h.level-1)}H${h.level}: ${h.text.slice(0,70)}`));
  }

  // INDEXABILITY
  console.log(head('🔎  INDEXABILITY'));
  console.log(renderStatus(status >= 200 && status < 300 ? 'ok' : 'fail', `HTTP Status — ${status}`));
  console.log(isIndexable ? ok('Robots meta — index allowed') : fail('Robots meta — noindex set!'));
  if (!isIndexable) console.log(info('Page blocked from Google by meta robots tag. Remove noindex to allow crawling.'));
  if (robotsMeta) console.log(dim(`robots: "${robotsMeta}"`));
  console.log(canonical ? ok(`Canonical — ${canonical}`) : warn('Canonical tag — Missing'));
  if (!canonical) console.log(info('Without canonical, Google may index duplicate versions (http vs https, trailing slash, etc).'));
  console.log(robotsStatus === 'ok' ? ok(`robots.txt — Found`) : fail(`robots.txt — Missing (${origin}/robots.txt)`));
  if (robotsStatus !== 'ok') console.log(info('robots.txt tells crawlers what to index. Missing = Google guesses. Always have one.'));
  console.log(sitemapStatus === 'ok' ? ok(`Sitemap — Found`) : fail(`Sitemap — Missing (${origin}/sitemap.xml)`));
  if (sitemapStatus !== 'ok') console.log(info('Sitemap tells Google every URL to index. Critical for multi-page sites and fast discovery.'));
  const loadStatus = loadMs < 1500 ? 'ok' : loadMs < 3000 ? 'warn' : 'fail';
  console.log(renderStatus(loadStatus, `Load Time — ${loadMs}ms`));
  if (loadMs > 3000) console.log(info('Over 3s loses rankings. Core Web Vitals are a ranking factor. Target under 1.5s.'));
  if (loadMs > 1500 && loadMs <= 3000) console.log(info('Decent but not great. Under 1.5s is the Core Web Vitals gold standard.'));

  // STRUCTURED DATA
  console.log(head('🧩  STRUCTURED DATA'));
  if (schemaTypes.length === 0) {
    console.log(fail('No JSON-LD schema found'));
    console.log(info('Schema enables rich results (FAQ dropdowns, star ratings, prices). No schema = plain blue link only.'));
  } else {
    for (const type of schemaTypes) console.log(ok(`Schema: ${type}`));
  }

  const wantedSchemas = {
    'FAQPage':             'FAQ rich results expand snippet to 3-4x size — massive CTR boost.',
    'SoftwareApplication': 'Tells Google this is an app (ratings, price, OS). Enables app-specific rich results.',
    'Organization':        'Confirms brand identity, logo, social profiles to Google Knowledge Graph.',
    'WebSite':             'Enables sitelinks search box for brand queries.',
    'BreadcrumbList':      'Shows page path in search results (Home > Category > Page).',
  };
  const missingSch = Object.entries(wantedSchemas).filter(([t]) => !schemaTypes.includes(t));
  if (missingSch.length) {
    console.log(chalk.gray('\n   Suggested schemas to add:'));
    for (const [type, reason] of missingSch.slice(0, 4)) {
      console.log(warn(`Missing: ${type}`));
      console.log(info(reason));
    }
  }

  // FAQ
  console.log(head('❓  FAQ'));
  if (schemas.some(s => s['@type'] === 'FAQPage')) {
    console.log(ok('FAQPage schema present'));
    console.log(info('FAQ schema shows Q&As inline in Google results. Can 2-3x your click-through rate.'));
  } else if (hasFaq) {
    console.log(warn('FAQ content detected — no FAQPage schema'));
    console.log(info('You have FAQ content but no markup. Add FAQPage JSON-LD to unlock rich results for free.'));
  } else {
    console.log(fail('No FAQ content or schema found'));
    console.log(info('FAQ sections are highest-ROI SEO additions. Answer common questions to capture featured snippets.'));
  }

  // SOCIAL
  console.log(head('📣  SOCIAL TAGS'));
  for (const key of ['og:title','og:description','og:image','og:type']) {
    console.log(og[key] ? ok(`${key}`) : warn(`${key} — Missing`));
  }
  if (!og['og:image']) console.log(info('OG image shows when shared on LinkedIn, Slack, iMessage. Missing = no thumbnail preview.'));
  for (const key of ['twitter:card','twitter:title','twitter:image']) {
    console.log(twitter[key] ? ok(`${key}`) : warn(`${key} — Missing`));
  }
  if (!twitter['twitter:card']) console.log(info('"summary_large_image" card shows a big preview on X/Twitter. High CTR from shares.'));

  // IMAGES
  console.log(head('🖼️   IMAGES'));
  console.log(ok(`Total images — ${images.length}`));
  console.log(missingAlt === 0
    ? ok(`Alt text — All ${images.length} images have alt text`)
    : warn(`Alt text — ${missingAlt}/${images.length} images missing alt text`));
  if (missingAlt > 0) console.log(info('Alt text is read by Google Images + screen readers. Missing = invisible to image search.'));

  // LINKS
  console.log(head('🔗  LINKS'));
  console.log(ok(`Internal links — ${internalLinks.length}`));
  if (internalLinks.length < 3) console.log(info('Low internal links = poor link equity flow. Link to key pages from the homepage.'));
  console.log(ok(`External links — ${externalLinks.length}`));
  if (externalLinks.length > 30) console.log(info('Many outbound links can dilute PageRank. Use rel="nofollow" where appropriate.'));

  // SUMMARY
  console.log(chalk.bold(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
  const fixes = [];
  if (titleInfo.status !== 'ok')   fixes.push('Fix meta title length');
  if (descInfo.status !== 'ok')    fixes.push('Write meta description');
  if (!headingCheck.ok)            fixes.push('Fix heading order (H1→H2→H3)');
  if (sitemapStatus !== 'ok')      fixes.push('Add sitemap.xml');
  if (robotsStatus !== 'ok')       fixes.push('Add robots.txt');
  if (!schemas.some(s => s['@type'] === 'FAQPage')) fixes.push('Add FAQPage schema');
  if (!schemaTypes.includes('Organization') && !schemaTypes.includes('SoftwareApplication')) fixes.push('Add Organization or SoftwareApplication schema');
  if (missingAlt > 0)              fixes.push(`Add alt text to ${missingAlt} images`);
  if (!publishedDate)              fixes.push('Add published date metadata');
  if (!canonical)                  fixes.push('Add canonical tag');

  if (fixes.length === 0) {
    console.log(chalk.bold.green('  🎉 No major issues found!'));
  } else {
    console.log(chalk.bold.white(`  🛠️  Top fixes (highest impact first):`));
    for (const [i, fix] of fixes.slice(0, 6).entries()) {
      console.log(chalk.white(`  ${i + 1}. ${fix}`));
    }
  }
  console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
}


// ── REPORT MODE ────────────────────────────────────────────────────────────

async function generateReport(rawUrl) {
  const { writeFileSync } = await import('fs');
  const parsedUrl = new URL(rawUrl);
  const origin    = parsedUrl.origin;
  const hostname  = parsedUrl.hostname.replace(/\./g, '-');
  const date      = new Date().toISOString().split('T')[0];
  const outFile   = `seo-report-${hostname}-${date}.md`;

  process.stdout.write(chalk.gray(`Auditing ${rawUrl} for report...\n`));

  const [raw, rendered, sitemapStatus, robotsStatus] = await Promise.all([
    fetchRaw(rawUrl),
    crawlPage(rawUrl),
    checkUrl(`${origin}/sitemap.xml`),
    checkUrl(`${origin}/robots.txt`),
  ]);

  const { schemas, og, twitter, canonical, robotsMeta, images, hasFaq } = parseRawHtml(raw.html);
  const { status, loadMs, title, metaDesc, headings, wordCount, internalLinks, externalLinks, publishedDate, modifiedDate } = rendered;

  const schemaTypes  = schemas.map(s => s['@type']).filter(Boolean);
  const missingAlt   = images.filter(i => i.alt === null || i.alt === '').length;
  const headingCheck = checkHeadingOrder(headings);
  const titleInfo    = titleLen(title);
  const descInfo     = descLen(metaDesc);
  const isIndexable  = !robotsMeta?.toLowerCase().includes('noindex');
  const loadStatus   = loadMs < 1500 ? 'ok' : loadMs < 3000 ? 'warn' : 'fail';

  // ── Build issues list with severity + fixes ──────────────────────────────

  const issues = [];

  // Title
  if (!title) {
    issues.push({ sev: '🔴', area: 'Content', problem: 'Meta title missing', fix: `Add a descriptive title, 50–60 chars. Example:\n  \`${parsedUrl.hostname} — [primary keyword]\`` });
  } else if (title.length < 30) {
    issues.push({ sev: '🟡', area: 'Content', problem: `Meta title too short (${title.length}/60): "${title}"`, fix: `Expand to 50–60 chars. Include primary keyword. Current title misses ranking opportunity.` });
  } else if (title.length > 60) {
    issues.push({ sev: '🟡', area: 'Content', problem: `Meta title too long (${title.length}/60): "${title}"`, fix: `Trim to under 60 chars. Google truncates longer titles in search results — your CTA or brand may get cut off.` });
  }

  // Description
  if (!metaDesc) {
    issues.push({ sev: '🔴', area: 'Content', problem: 'Meta description missing', fix: `Write a 120–160 char description that includes your primary keyword and a clear value prop. Without it, Google picks random page text.` });
  } else if (metaDesc.length < 50) {
    issues.push({ sev: '🔴', area: 'Content', problem: `Meta description too short (${metaDesc.length} chars): "${metaDesc}"`, fix: `Expand to 120–160 chars. Descriptions this short signal low effort to Google and get rewritten automatically.` });
  } else if (metaDesc.length > 160) {
    issues.push({ sev: '🟡', area: 'Content', problem: `Meta description too long (${metaDesc.length} chars)`, fix: `Trim to under 160 chars. Anything beyond gets truncated in search results — your CTA may be invisible.` });
  }

  // Word count
  if (wordCount < 300) {
    issues.push({ sev: '🔴', area: 'Content', problem: `Very thin content — ${wordCount} words rendered`, fix: `Under 300 words risks being classified as thin content. Add: feature descriptions, a quick-start code block, an FAQ section, or a supported integrations list.` });
  } else if (wordCount < 600) {
    issues.push({ sev: '🟡', area: 'Content', problem: `Thin content — ${wordCount} words`, fix: `300–600 words is borderline. Competitors with deeper content tend to outrank for informational queries. Aim for 600+ words.` });
  }

  // Dates
  if (!publishedDate) {
    issues.push({ sev: '🟢', area: 'Content', problem: 'Published date metadata missing', fix: `Add \`<meta property="article:published_time" content="YYYY-MM-DD" />\` or datePublished in JSON-LD. Signals freshness to Google.` });
  }
  if (!modifiedDate) {
    issues.push({ sev: '🟢', area: 'Content', problem: 'Modified date metadata missing', fix: `Add \`<meta property="article:modified_time" content="YYYY-MM-DD" />\` or dateModified in JSON-LD. Tells Google the content is maintained.` });
  }

  // Headings
  if (!headingCheck.ok) {
    for (const issue of headingCheck.issues) {
      issues.push({ sev: '🟡', area: 'Headings', problem: `Heading structure: ${issue}`, fix: `Fix heading hierarchy to H1 → H2 → H3. Skipping levels confuses Google's content parser and weakens topical relevance signals.` });
    }
  }

  // Indexability
  if (!isIndexable) {
    issues.push({ sev: '🔴', area: 'Indexability', problem: 'Page blocked by noindex meta robots tag', fix: `Remove \`noindex\` from the robots meta tag. Currently Google will not index this page at all.` });
  }
  if (!canonical) {
    issues.push({ sev: '🟡', area: 'Indexability', problem: 'Canonical tag missing', fix: `Add \`<link rel="canonical" href="${rawUrl}" />\`. Without it, Google may index duplicate URL variants (http/https, trailing slash, www/non-www).` });
  } else if (canonical.includes('www.') && !rawUrl.includes('www.')) {
    issues.push({ sev: '🟡', area: 'Indexability', problem: `Canonical mismatch — points to ${canonical} but page is served at ${rawUrl}`, fix: `Update canonical to match the served URL: \`<link rel="canonical" href="${rawUrl}" />\`` });
  }
  if (robotsStatus !== 'ok') {
    issues.push({ sev: '🔴', area: 'Indexability', problem: `robots.txt missing at ${origin}/robots.txt`, fix: `Create a robots.txt at the domain root:\n  \`User-agent: *\n  Allow: /\n  Sitemap: ${origin}/sitemap.xml\`` });
  }
  if (sitemapStatus !== 'ok') {
    issues.push({ sev: '🔴', area: 'Indexability', problem: `sitemap.xml missing at ${origin}/sitemap.xml`, fix: `Generate and submit a sitemap. For Next.js: use next-sitemap. For Astro: npx astro add sitemap. Then submit at Google Search Console.` });
  }
  if (loadStatus === 'warn') {
    issues.push({ sev: '🟡', area: 'Indexability', problem: `Load time ${loadMs}ms — above 1.5s target`, fix: `Investigate render-blocking resources, image sizes, and TTFB. Core Web Vitals affect rankings. Target under 1.5s.` });
  }
  if (loadStatus === 'fail') {
    issues.push({ sev: '🔴', area: 'Indexability', problem: `Load time ${loadMs}ms — above 3s`, fix: `Critical performance issue. Google deprioritises slow pages. Audit with Lighthouse, compress images, defer JS, use a CDN.` });
  }

  // Schema
  if (schemaTypes.length === 0) {
    issues.push({ sev: '🔴', area: 'Structured Data', problem: 'No JSON-LD schema found', fix: `Add at minimum Organization schema. Without any schema, Google only shows a plain blue link — no rich results possible.` });
  }
  if (!schemas.some(s => s['@type'] === 'FAQPage')) {
    if (hasFaq) {
      issues.push({ sev: '🔴', area: 'Structured Data', problem: 'FAQ content detected but no FAQPage schema', fix: `Wrap your FAQ section in FAQPage JSON-LD. This is a free upgrade — Google can show your Q&As inline in search results, expanding your listing 3-4x.` });
    } else {
      issues.push({ sev: '🟡', area: 'Structured Data', problem: 'No FAQ section or FAQPage schema', fix: `Add a FAQ section answering 3–5 common questions, then mark it up with FAQPage schema. One of the highest-ROI SEO additions for developer tools.` });
    }
  }
  if (!schemaTypes.includes('Organization')) {
    issues.push({ sev: '🟡', area: 'Structured Data', problem: 'Organization schema missing', fix: `Add Organization JSON-LD with name, url, logo, and sameAs (Twitter, GitHub). Builds brand entity in Google Knowledge Graph.` });
  }
  if (!schemaTypes.includes('SoftwareApplication') && !schemaTypes.includes('Product')) {
    issues.push({ sev: '🟡', area: 'Structured Data', problem: 'No SoftwareApplication or Product schema', fix: `Add SoftwareApplication schema with applicationCategory, offers, and description. Enables app-specific rich results in Google.` });
  }

  // OG / Social
  const ogKeys = ['og:title','og:description','og:image','og:type'];
  for (const key of ogKeys) {
    if (!og[key]) {
      issues.push({ sev: '🟡', area: 'Social', problem: `Missing ${key}`, fix: `Add \`<meta property="${key}" content="..." />\`. ${key === 'og:image' ? 'OG image controls the thumbnail when shared on LinkedIn, Slack, iMessage, X. Use 1200×630px PNG.' : 'Controls how your link appears when shared on social platforms.'}` });
    }
  }
  if (og['og:image']?.includes('cdn.discordapp.com') || og['og:image']?.includes('pbs.twimg.com')) {
    issues.push({ sev: '🔴', area: 'Social', problem: `OG image hosted on external CDN (${og['og:image']?.split('/')[2]}) — URL will expire`, fix: `Host the OG image on your own CDN or S3 bucket. Discord CDN URLs expire and will break social previews permanently.` });
  }
  if (!twitter['twitter:card']) {
    issues.push({ sev: '🟡', area: 'Social', problem: 'Twitter card missing', fix: `Add \`<meta name="twitter:card" content="summary_large_image" />\` plus twitter:title, twitter:description, twitter:image. Controls appearance on X/Twitter.` });
  }

  // Images
  if (missingAlt > 0) {
    issues.push({ sev: '🟡', area: 'Images', problem: `${missingAlt} image(s) missing alt text`, fix: `Add descriptive alt attributes to all images. Alt text feeds Google Images, screen readers, and is a minor ranking signal.` });
  }

  // Internal links
  if (internalLinks < 3) {
    issues.push({ sev: '🟢', area: 'Links', problem: `Only ${internalLinks} internal link(s)`, fix: `Add links to key pages (docs, pricing, signup). Internal links distribute PageRank across your site and help Google discover deeper pages.` });
  }

  // Sort by severity
  const sevOrder = { '🔴': 0, '🟡': 1, '🟢': 2 };
  issues.sort((a, b) => sevOrder[a.sev] - sevOrder[b.sev]);

  const critical = issues.filter(i => i.sev === '🔴');
  const warnings = issues.filter(i => i.sev === '🟡');
  const info     = issues.filter(i => i.sev === '🟢');

  // ── Write markdown ────────────────────────────────────────────────────────

  const lines = [];

  lines.push(`# SEO Audit Report — ${rawUrl}`);
  lines.push(`**Date:** ${date}  `);
  lines.push(`**Tool:** SEO Intel (froggo.pro)\n`);
  lines.push(`---\n`);

  // Score card
  lines.push(`## Overview\n`);
  lines.push(`| Metric | Value | Status |`);
  lines.push(`|--------|-------|--------|`);
  lines.push(`| HTTP Status | ${status} | ${status >= 200 && status < 300 ? '✅' : '❌'} |`);
  lines.push(`| Load Time | ${loadMs}ms | ${loadStatus === 'ok' ? '✅' : loadStatus === 'warn' ? '⚠️' : '❌'} |`);
  lines.push(`| Word Count | ${wordCount} | ${wordCount >= 600 ? '✅' : wordCount >= 300 ? '⚠️' : '❌'} |`);
  lines.push(`| Meta Title | ${title ? `"${title.slice(0,50)}${title.length>50?'...':''}" (${title.length} chars)` : 'Missing'} | ${titleInfo.status === 'ok' ? '✅' : titleInfo.status === 'warn' ? '⚠️' : '❌'} |`);
  lines.push(`| Meta Description | ${metaDesc ? `${metaDesc.length} chars` : 'Missing'} | ${descInfo.status === 'ok' ? '✅' : descInfo.status === 'warn' ? '⚠️' : '❌'} |`);
  lines.push(`| Canonical | ${canonical || 'Missing'} | ${canonical ? '✅' : '❌'} |`);
  lines.push(`| Indexable | ${isIndexable ? 'Yes' : 'No (noindex set!)'} | ${isIndexable ? '✅' : '❌'} |`);
  lines.push(`| robots.txt | ${robotsStatus === 'ok' ? 'Found' : 'Missing'} | ${robotsStatus === 'ok' ? '✅' : '❌'} |`);
  lines.push(`| sitemap.xml | ${sitemapStatus === 'ok' ? 'Found' : 'Missing'} | ${sitemapStatus === 'ok' ? '✅' : '❌'} |`);
  lines.push(`| Schema types | ${schemaTypes.length ? schemaTypes.join(', ') : 'None'} | ${schemaTypes.length ? '⚠️' : '❌'} |`);
  lines.push(`| FAQPage schema | ${schemas.some(s=>s['@type']==='FAQPage') ? 'Present' : 'Missing'} | ${schemas.some(s=>s['@type']==='FAQPage') ? '✅' : '❌'} |`);
  lines.push(`| OG Tags | ${Object.keys(og).length} found | ${Object.keys(og).length >= 4 ? '✅' : '⚠️'} |`);
  lines.push(`| Twitter Card | ${twitter['twitter:card'] || 'Missing'} | ${twitter['twitter:card'] ? '✅' : '❌'} |`);
  lines.push(`| Images | ${images.length} total, ${missingAlt} missing alt | ${missingAlt === 0 ? '✅' : '⚠️'} |`);
  lines.push(`| Internal Links | ${internalLinks} | ${internalLinks >= 3 ? '✅' : '⚠️'} |`);
  lines.push(`| Published Date | ${publishedDate || 'Missing'} | ${publishedDate ? '✅' : '⚠️'} |`);
  lines.push(`| Modified Date | ${modifiedDate || 'Missing'} | ${modifiedDate ? '✅' : '⚠️'} |\n`);

  // Issue counts
  lines.push(`**${critical.length} critical · ${warnings.length} warnings · ${info.length} info**\n`);
  lines.push(`---\n`);

  // Issues by severity
  if (critical.length) {
    lines.push(`## 🔴 Critical Issues\n`);
    for (const issue of critical) {
      lines.push(`### ${issue.area} — ${issue.problem}\n`);
      lines.push(`**Fix:** ${issue.fix}\n`);
    }
    lines.push(`---\n`);
  }

  if (warnings.length) {
    lines.push(`## 🟡 Warnings\n`);
    for (const issue of warnings) {
      lines.push(`### ${issue.area} — ${issue.problem}\n`);
      lines.push(`**Fix:** ${issue.fix}\n`);
    }
    lines.push(`---\n`);
  }

  if (info.length) {
    lines.push(`## 🟢 Info / Nice to Have\n`);
    for (const issue of info) {
      lines.push(`### ${issue.area} — ${issue.problem}\n`);
      lines.push(`**Fix:** ${issue.fix}\n`);
    }
    lines.push(`---\n`);
  }

  // Headings snapshot
  if (headings.length) {
    lines.push(`## Heading Structure\n`);
    lines.push('```');
    for (const h of headings.slice(0, 10)) {
      lines.push(`${'  '.repeat(h.level - 1)}H${h.level}: ${h.text.slice(0, 80)}`);
    }
    if (headings.length > 10) lines.push(`... and ${headings.length - 10} more`);
    lines.push('```\n');
    lines.push(`---\n`);
  }

  // Schema snapshot
  if (schemas.length) {
    lines.push(`## Schema Found\n`);
    for (const s of schemas) {
      lines.push(`- **${s['@type']}** ${s.name ? `— ${s.name}` : ''}`);
    }
    lines.push('');
    lines.push(`---\n`);
  }

  // Priority fix list
  lines.push(`## Priority Fix List\n`);
  lines.push(`| Priority | Area | Fix |`);
  lines.push(`|----------|------|-----|`);
  for (const [i, issue] of issues.slice(0, 10).entries()) {
    const shortFix = issue.fix.split('\n')[0].slice(0, 80);
    lines.push(`| ${issue.sev} ${i + 1} | ${issue.area} | ${shortFix} |`);
  }
  lines.push('');
  lines.push(`---\n`);
  lines.push(`*Generated by SEO Intel — froggo.pro*`);

  const md = lines.join('\n');
  writeFileSync(outFile, md);

  console.log(chalk.bold.green(`\n✅ Report saved: ${outFile}`));
  console.log(chalk.gray(`   ${critical.length} critical · ${warnings.length} warnings · ${info.length} info\n`));
}

// ── Route to correct mode ───────────────────────────────────────────────────
if (reportMode) {
  generateReport(url).catch(err => {
    console.error(chalk.red('Report failed:'), err.message);
    process.exit(1);
  });
} else {
  audit(url).catch(err => {
    console.error(chalk.red('Audit failed:'), err.message);
    process.exit(1);
  });
}
