import { collectTop, inferPriorityFromCount, makeAction, sortActions } from './heuristics.js';
import { getTechnicalDataset } from './queries.js';

export function buildTechnicalActions(db, project) {
  const rows = getTechnicalDataset(db, project);
  const actions = [];

  const missingSchema = rows.filter(r => !r.schema_count && !r.has_schema);
  if (missingSchema.length) {
    actions.push(makeAction({
      id: 'technical-missing-schema',
      type: 'add_schema',
      priority: inferPriorityFromCount(missingSchema.length, { critical: 25, high: 10, medium: 4 }),
      area: 'schema',
      title: `Add structured data to ${missingSchema.length} target pages`,
      why: 'Pages without schema miss eligibility for rich results and machine-readable context.',
      evidence: collectTop(missingSchema.map(r => `${r.url} (status ${r.status_code || 'n/a'})`), 8),
      implementationHints: [
        'Map page templates to schema types like Organization, Product, FAQ, Article, BreadcrumbList, and WebPage.',
        'Generate JSON-LD server-side so it is present in raw HTML.',
        'Prioritize money pages, docs hubs, and comparison pages first.',
      ],
    }));
  }

  const brokenPages = rows.filter(r => Number(r.status_code) >= 400);
  if (brokenPages.length) {
    actions.push(makeAction({
      id: 'technical-broken-pages',
      type: 'fix',
      priority: inferPriorityFromCount(brokenPages.length, { critical: 5, high: 3, medium: 1 }),
      area: 'technical',
      title: `Fix ${brokenPages.length} broken target pages returning 4xx/5xx`,
      why: 'Broken pages waste crawl budget, lose link equity, and create dead ends in user journeys.',
      evidence: collectTop(brokenPages.map(r => `${r.url} → ${r.status_code}`), 10),
      implementationHints: [
        'Restore the intended page or 301 it to the nearest equivalent live URL.',
        'Update internal links pointing to these URLs after the redirect or fix.',
      ],
    }));
  }

  const orphanPages = rows.filter(r => r.click_depth > 0 && r.inbound_internal_links === 0 && Number(r.status_code) < 400);
  if (orphanPages.length) {
    actions.push(makeAction({
      id: 'technical-orphans',
      type: 'fix',
      priority: inferPriorityFromCount(orphanPages.length, { critical: 15, high: 7, medium: 3 }),
      area: 'structure',
      title: `Reconnect ${orphanPages.length} orphan pages to the internal link graph`,
      why: 'Pages with no discovered internal links pointing at them are harder for crawlers and users to find.',
      evidence: collectTop(orphanPages.map(r => `${r.url} (depth ${r.click_depth})`), 10),
      implementationHints: [
        'Add contextual links from hub pages, nav, docs indexes, and related content blocks.',
        'Review sitemap inclusion for pages that should rank.',
      ],
    }));
  }

  const thinPages = rows.filter(r => (r.word_count || 0) > 0 && r.word_count < 200 && Number(r.status_code) < 400);
  if (thinPages.length) {
    actions.push(makeAction({
      id: 'technical-thin-pages',
      type: 'improve',
      priority: inferPriorityFromCount(thinPages.length, { critical: 30, high: 12, medium: 5 }),
      area: 'content',
      title: `Strengthen ${thinPages.length} thin pages under 200 words`,
      why: 'Very short pages usually fail to satisfy intent unless they are utility endpoints or redirects.',
      evidence: collectTop(thinPages.map(r => `${r.url} (${r.word_count} words)`), 10),
      implementationHints: [
        'Add clear H1/H2 structure, core benefit copy, FAQs, examples, and internal links.',
        'Merge low-value pages into stronger canonical assets when intent overlaps.',
      ],
    }));
  }

  const deepPages = rows.filter(r => (r.click_depth || 0) > 3 && Number(r.status_code) < 400);
  if (deepPages.length) {
    actions.push(makeAction({
      id: 'technical-deep-pages',
      type: 'fix',
      priority: inferPriorityFromCount(deepPages.length, { critical: 20, high: 8, medium: 3 }),
      area: 'structure',
      title: `Pull ${deepPages.length} deep pages closer than 4 clicks from entry points`,
      why: 'Important URLs buried deep in the crawl path tend to receive less internal authority and lower discovery frequency.',
      evidence: collectTop(deepPages.map(r => `${r.url} (depth ${r.click_depth})`), 10),
      implementationHints: [
        'Promote high-value URLs into nav, footer, hub, or resource index pages.',
        'Add breadcrumb trails and category pages to shorten crawl distance.',
      ],
    }));
  }

  const missingH1 = rows.filter(r => !r.h1_count && !String(r.h1 || '').trim() && Number(r.status_code) < 400);
  if (missingH1.length) {
    actions.push(makeAction({
      id: 'technical-missing-h1',
      type: 'fix',
      priority: inferPriorityFromCount(missingH1.length, { critical: 20, high: 8, medium: 3 }),
      area: 'content',
      title: `Add unique H1s to ${missingH1.length} pages`,
      why: 'Missing H1s weaken topic clarity for both users and search engines.',
      evidence: collectTop(missingH1.map(r => r.url), 10),
      implementationHints: [
        'Align the H1 with page intent and supporting title/meta copy.',
        'Use one clear H1 per page instead of decorative empty hero copy.',
      ],
    }));
  }

  const missingMeta = rows.filter(r => !String(r.meta_desc || '').trim() && Number(r.status_code) < 400);
  if (missingMeta.length) {
    actions.push(makeAction({
      id: 'technical-missing-meta',
      type: 'improve',
      priority: inferPriorityFromCount(missingMeta.length, { critical: 25, high: 10, medium: 4 }),
      area: 'content',
      title: `Write meta descriptions for ${missingMeta.length} pages`,
      why: 'Missing meta descriptions reduce control over SERP snippets and CTR messaging.',
      evidence: collectTop(missingMeta.map(r => r.url), 10),
      implementationHints: [
        'Write intent-matched descriptions around 140–160 characters.',
        'Highlight the core outcome, differentiator, and CTA.',
      ],
    }));
  }

  const redirectChains = rows.filter(r => (r.redirects_linked_from_page || 0) > 0);
  if (redirectChains.length) {
    actions.push(makeAction({
      id: 'technical-redirect-chains',
      type: 'fix',
      priority: inferPriorityFromCount(redirectChains.length, { critical: 12, high: 5, medium: 2 }),
      area: 'technical',
      title: `Update internal links on ${redirectChains.length} pages that point to redirects`,
      why: 'Internal links that hit redirects waste crawl hops and can become redirect chains over time.',
      evidence: collectTop(redirectChains.map(r => `${r.url} (${r.redirects_linked_from_page} redirecting links)`), 10),
      implementationHints: [
        'Replace redirecting targets with their final destination URLs in nav and body content.',
        'Audit legacy paths generated by CMS migrations or product renames.',
      ],
    }));
  }

  const missingCanonical = rows.filter(r => !r.has_canonical && Number(r.status_code) < 400);
  if (missingCanonical.length) {
    actions.push(makeAction({
      id: 'technical-missing-canonical',
      type: 'fix',
      priority: inferPriorityFromCount(missingCanonical.length, { critical: 20, high: 10, medium: 4 }),
      area: 'technical',
      title: `Add canonical tags to ${missingCanonical.length} pages`,
      why: 'Canonical tags help consolidate duplicate or near-duplicate URLs and reduce ambiguity.',
      evidence: collectTop(missingCanonical.map(r => r.url), 10),
      implementationHints: [
        'Ensure every canonical points to the preferred self URL or the consolidated destination.',
        'Keep canonicals consistent across parameterized, localized, and paginated pages.',
      ],
    }));
  }

  const missingOg = rows.filter(r => !r.has_og_tags && Number(r.status_code) < 400);
  if (missingOg.length) {
    actions.push(makeAction({
      id: 'technical-missing-og',
      type: 'improve',
      priority: inferPriorityFromCount(missingOg.length, { critical: 25, high: 10, medium: 4 }),
      area: 'technical',
      title: `Add Open Graph tags to ${missingOg.length} pages`,
      why: 'OG tags improve share previews and often correlate with better metadata hygiene across templates.',
      evidence: collectTop(missingOg.map(r => r.url), 10),
      implementationHints: [
        'Populate og:title, og:description, og:image, and og:url on every indexable template.',
        'Generate reusable social preview images for docs, product, and comparison templates.',
      ],
    }));
  }

  return sortActions(actions);
}
