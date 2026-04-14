/**
 * Template Analysis Orchestrator
 *
 * Runs five phases:
 *   1. URL Pattern Clustering (sitemap parse → cluster)
 *   2. Smart Sampling (stealth crawl ~20 pages/group)
 *   3. GSC Overlay (cross-reference with Search Console data)
 *   4. Scoring & Recommendations
 *   5. Template Profile Extrapolation (infer extraction fields for all URLs from samples)
 *
 * Then writes results to DB and returns the report.
 */

import { fetchSitemap } from '../../crawler/sitemap.js';
import { loadGscData } from '../../reports/gsc-loader.js';
import { loadAllConfigs } from '../../scheduler.js';
import { getDb, upsertTemplateGroup, getTemplateGroupId, upsertTemplateSample } from '../../db/db.js';
import { clusterUrls } from './cluster.js';
import { selectSample, crawlSample } from './sampler.js';
import { averageSimilarity, averageFingerprintSimilarity } from './similarity.js';
import { overlayGsc } from './gsc-overlay.js';
import { scoreGroup } from './scorer.js';

/**
 * Run full template analysis for a project.
 *
 * @param {string} project
 * @param {object} opts
 * @param {number}  opts.minGroupSize — min URLs per template (default 10)
 * @param {number}  opts.sampleSize — pages to crawl per group (default 20)
 * @param {boolean} opts.skipCrawl — skip Phase 2 (pattern + GSC only)
 * @param {boolean} opts.skipGsc — skip Phase 3
 * @param {Function} opts.log — (message) => void (default console.log)
 * @returns {Promise<TemplatesReport>}
 */
export async function runTemplatesAnalysis(project, opts = {}) {
  const log = opts.log || console.log;
  const minGroupSize = opts.minGroupSize || 10;
  const sampleSize = opts.sampleSize || 20;

  // ── Load project config ──
  const configs = loadAllConfigs();
  const config = configs.find(c => c.project === project);
  if (!config) throw new Error(`Project "${project}" not found. Run: seo-intel setup`);

  const targetDomain = config.target.domain;
  const targetUrl = (config.target.url || `https://${targetDomain}`).replace(/\/+$/, '');

  log(`\n  Target: ${targetDomain}`);

  // ═══ PHASE 1: URL Pattern Clustering ═══
  log(`\n  Phase 1: URL Pattern Clustering`);
  log(`  Fetching sitemap...`);

  const sitemapEntries = await fetchSitemap(targetUrl);

  if (!sitemapEntries.length) {
    log(`  ⚠️  No sitemap URLs found for ${targetDomain}`);
    log(`  Ensure sitemap.xml is accessible at ${targetUrl}/sitemap.xml`);
    return { groups: [], stats: { totalUrls: 0, totalGroups: 0, coverage: 0 }, project, domain: targetDomain };
  }

  log(`  Found ${sitemapEntries.length.toLocaleString()} URLs in sitemap`);

  const { groups, ungrouped, stats } = clusterUrls(sitemapEntries, { minGroupSize });

  log(`  ${stats.totalGroups} template groups found`);
  log(`  Coverage: ${stats.totalGrouped.toLocaleString()} URLs (${(stats.coverage * 100).toFixed(1)}% of sitemap)`);
  log('');

  if (groups.length === 0) {
    log(`  No template patterns detected (all pages are unique).`);
    return { groups: [], ungrouped, stats, project, domain: targetDomain };
  }

  // Show discovered patterns
  const maxPatternLen = Math.max(...groups.map(g => g.pattern.length), 7);
  log(`  ${'Pattern'.padEnd(maxPatternLen)}  ${'URLs'.padStart(8)}  Verdict`);
  log(`  ${'─'.repeat(maxPatternLen)}  ${'─'.repeat(8)}  ─────────`);
  for (const g of groups) {
    log(`  ${g.pattern.padEnd(maxPatternLen)}  ${g.urlCount.toLocaleString().padStart(8)}  [pending]`);
  }
  log('');

  // ═══ PHASE 2: Smart Sample Crawl ═══
  if (!opts.skipCrawl) {
    log(`  Phase 2: Smart Sample Crawl (stealth)`);

    for (const group of groups) {
      const sample = selectSample(group.urls, sampleSize);
      log(`  Sampling ${group.pattern}... ${sample.length} pages`);

      try {
        const results = await crawlSample(sample, {
          hostname: targetDomain,
          onPage: (result, idx, total) => {
            const status = result.statusCode >= 400 ? '✗' : result.statusCode > 0 ? '✓' : '?';
            process.stdout.write(`    [${idx + 1}/${total}] ${status} ${result.url.replace(/https?:\/\/[^/]+/, '').slice(0, 50)}\n`);
          },
        });

        group.samples = results;
        group.sampleSize = results.filter(r => r.statusCode > 0 && r.statusCode < 400).length;

        // Compute similarity stats from successful samples
        const successful = results.filter(r => r.statusCode > 0 && r.statusCode < 400);
        if (successful.length >= 2) {
          const bodyTexts = successful.map(r => r.bodyText).filter(Boolean);
          const fingerprints = successful.map(r => r.domFingerprintStr).filter(Boolean);

          group.avgWordCount = successful.reduce((s, r) => s + (r.wordCount || 0), 0) / successful.length;
          group.contentSimilarity = averageSimilarity(bodyTexts);
          group.domSimilarity = averageFingerprintSimilarity(fingerprints);
          group.canonicalRate = successful.filter(r => r.hasCanonical).length / successful.length;
        } else {
          group.avgWordCount = successful[0]?.wordCount || 0;
          group.contentSimilarity = null;
          group.domSimilarity = null;
          group.canonicalRate = null;
        }

        log(`    ✓ ${group.sampleSize} successful, similarity: ${group.contentSimilarity != null ? (group.contentSimilarity * 100).toFixed(0) + '%' : 'N/A'}`);
      } catch (err) {
        log(`    ✗ Sample crawl failed: ${err.message}`);
        group.samples = [];
        group.sampleSize = 0;
      }
    }
    log('');
  } else {
    log(`  Phase 2: Skipped (--skip-crawl)`);
    for (const g of groups) {
      g.samples = [];
      g.sampleSize = 0;
    }
    log('');
  }

  // ═══ PHASE 3: GSC Overlay ═══
  if (!opts.skipGsc) {
    log(`  Phase 3: GSC Overlay`);
    const gscData = loadGscData(project);
    if (gscData?.pages?.length) {
      log(`  Loaded GSC data: ${gscData.pages.length.toLocaleString()} pages with data`);
      const overlayed = overlayGsc(groups, gscData.pages);
      // Merge GSC fields back into groups
      for (let i = 0; i < groups.length; i++) {
        Object.assign(groups[i], {
          gscUrlsWithImpressions: overlayed[i].gscUrlsWithImpressions,
          gscTotalClicks: overlayed[i].gscTotalClicks,
          gscTotalImpressions: overlayed[i].gscTotalImpressions,
          gscAvgPosition: overlayed[i].gscAvgPosition,
          indexationEfficiency: overlayed[i].indexationEfficiency,
          topGscUrls: overlayed[i].topGscUrls,
        });
      }
      log(`  Matched template URLs against GSC data`);
    } else {
      log(`  No GSC data found for ${project}`);
      for (const g of groups) {
        g.gscUrlsWithImpressions = null;
        g.gscTotalClicks = null;
        g.gscTotalImpressions = null;
        g.gscAvgPosition = null;
        g.indexationEfficiency = null;
        g.topGscUrls = [];
      }
    }
    log('');
  } else {
    log(`  Phase 3: Skipped (--skip-gsc)\n`);
  }

  // ═══ PHASE 4: Scoring & Recommendations ═══
  log(`  Phase 4: Scoring & Recommendations`);

  for (const group of groups) {
    const result = scoreGroup(group);
    group.score = result.score;
    group.verdict = result.verdict;
    group.recommendation = result.recommendations;

    const verdictColor = { 'high-value': '🟢', mixed: '🟡', thin: '🟠', invisible: '🔴' };
    log(`  ${(verdictColor[group.verdict] || '⚪')} ${group.pattern.padEnd(maxPatternLen)}  → ${group.verdict} (score: ${group.score})`);
  }
  log('');

  // ═══ PHASE 5: Template Profile Extrapolation ═══
  // For each group with samples, build an "inferred profile" — the common fields
  // that apply to ALL URLs in the group. This lets us "know" 47k pages from 20 samples.
  log(`  Phase 5: Template Profile Extrapolation`);

  for (const group of groups) {
    group.profile = buildTemplateProfile(group);
    if (group.profile) {
      const p = group.profile;
      log(`  ${group.pattern}: ${group.urlCount.toLocaleString()} pages inferred`);
      log(`    schema: ${p.schemaPresence}% · canonical: ${p.canonicalPresence}% · indexable: ${p.indexablePresence}% · avg words: ${Math.round(p.avgWordCount)}`);
    }
  }
  log('');

  // ═══ PHASE 6: Competitor Sitemap Census ═══
  // Fetch competitor sitemaps and cluster them — zero crawling, just URL counting.
  // Shows: "You have 200 swap pages, Jupiter has 47k" — instant competitive intel.
  const competitorCensus = [];
  const competitors = config.competitors || [];

  if (competitors.length > 0 && !opts.skipCompetitors) {
    log(`  Phase 6: Competitor Sitemap Census`);

    for (const comp of competitors) {
      const compUrl = comp.url || `https://${comp.domain}`;
      log(`  Scanning ${comp.domain}...`);

      try {
        const compEntries = await fetchSitemap(compUrl);
        if (compEntries.length === 0) {
          log(`    No sitemap found`);
          competitorCensus.push({ domain: comp.domain, totalUrls: 0, groups: [] });
          continue;
        }

        const compResult = clusterUrls(compEntries, { minGroupSize });
        competitorCensus.push({
          domain: comp.domain,
          totalUrls: compResult.stats.totalUrls,
          groups: compResult.groups.map(g => ({
            pattern: g.pattern,
            urlCount: g.urlCount,
          })),
          stats: compResult.stats,
        });

        log(`    ${compEntries.length.toLocaleString()} URLs → ${compResult.stats.totalGroups} templates`);
        for (const g of compResult.groups.slice(0, 5)) {
          log(`      ${g.pattern.padEnd(30)} ${g.urlCount.toLocaleString().padStart(8)} URLs`);
        }
        if (compResult.groups.length > 5) {
          log(`      ... and ${compResult.groups.length - 5} more`);
        }
      } catch (err) {
        log(`    ✗ Failed: ${err.message}`);
        competitorCensus.push({ domain: comp.domain, totalUrls: 0, groups: [], error: err.message });
      }
    }
    log('');
  }

  // ═══ Write to DB ═══
  const db = getDb();
  const analyzedAt = Date.now();

  for (const group of groups) {
    upsertTemplateGroup(db, {
      project,
      domain: targetDomain,
      pattern: group.pattern,
      urlCount: group.urlCount,
      sampleSize: group.sampleSize || 0,
      avgWordCount: group.avgWordCount,
      contentSimilarity: group.contentSimilarity,
      domSimilarity: group.domSimilarity,
      gscUrlsWithImpressions: group.gscUrlsWithImpressions,
      gscTotalClicks: group.gscTotalClicks,
      gscTotalImpressions: group.gscTotalImpressions,
      gscAvgPosition: group.gscAvgPosition,
      indexationEfficiency: group.indexationEfficiency,
      score: group.score,
      verdict: group.verdict,
      recommendation: group.recommendation,
      analyzedAt,
    });

    // Save samples
    if (group.samples?.length) {
      const groupId = getTemplateGroupId(db, project, targetDomain, group.pattern);
      if (groupId) {
        for (const s of group.samples) {
          upsertTemplateSample(db, {
            groupId,
            url: s.url,
            sampleRole: s.sampleRole,
            statusCode: s.statusCode,
            wordCount: s.wordCount,
            title: s.title,
            metaDesc: s.metaDesc,
            hasCanonical: s.hasCanonical,
            hasSchema: s.hasSchema,
            isIndexable: s.isIndexable,
            domFingerprint: s.domFingerprintStr,
            contentHash: s.contentHash,
            bodyText: s.bodyText,
            crawledAt: s.crawledAt,
          });
        }
      }
    }
  }

  log(`  Results saved to database.`);

  return {
    project,
    domain: targetDomain,
    groups,
    ungrouped,
    stats,
    competitorCensus,
    analyzedAt,
  };
}

/**
 * Build an inferred profile for a template group from its samples.
 *
 * If 20 sampled pages from /swap/{pair} show:
 *   - 95% have schema markup
 *   - 100% have canonical tags
 *   - avg 180 words
 *   - all use the same DOM structure
 *
 * We can extrapolate that to all 47,000 pages in the group.
 * This replaces the need to crawl+extract every page.
 *
 * @param {object} group — template group with .samples[]
 * @returns {object|null} — inferred profile, or null if no usable samples
 */
function buildTemplateProfile(group) {
  const samples = (group.samples || []).filter(s => s.statusCode > 0 && s.statusCode < 400);
  if (samples.length < 2) return null;

  const n = samples.length;

  // ── Presence rates (extrapolated to all URLs in group) ──
  const schemaPresence = Math.round((samples.filter(s => s.hasSchema).length / n) * 100);
  const canonicalPresence = Math.round((samples.filter(s => s.hasCanonical).length / n) * 100);
  const indexablePresence = Math.round((samples.filter(s => s.isIndexable).length / n) * 100);

  // ── Content stats ──
  const avgWordCount = samples.reduce((sum, s) => sum + (s.wordCount || 0), 0) / n;
  const minWordCount = Math.min(...samples.map(s => s.wordCount || 0));
  const maxWordCount = Math.max(...samples.map(s => s.wordCount || 0));

  // ── Title/meta pattern detection ──
  // Find the common template in titles by extracting shared prefixes/suffixes
  const titlePattern = detectPattern(samples.map(s => s.title).filter(Boolean));
  const metaPattern = detectPattern(samples.map(s => s.metaDesc).filter(Boolean));

  // ── Unique content hashes ──
  const uniqueHashes = new Set(samples.map(s => s.contentHash).filter(Boolean));
  const contentDiversity = uniqueHashes.size / n; // 1.0 = all unique, low = duplicates

  // ── Inferred totals (extrapolated) ──
  const estimatedWithSchema = Math.round(group.urlCount * (schemaPresence / 100));
  const estimatedWithCanonical = Math.round(group.urlCount * (canonicalPresence / 100));
  const estimatedIndexable = Math.round(group.urlCount * (indexablePresence / 100));
  const estimatedTotalWords = Math.round(group.urlCount * avgWordCount);

  return {
    sampleCount: n,
    totalInferred: group.urlCount,

    // Rates (%)
    schemaPresence,
    canonicalPresence,
    indexablePresence,

    // Content
    avgWordCount,
    minWordCount,
    maxWordCount,
    contentDiversity,
    estimatedTotalWords,

    // Patterns
    titlePattern,
    metaPattern,

    // Extrapolated totals
    estimatedWithSchema,
    estimatedWithCanonical,
    estimatedIndexable,
  };
}

/**
 * Detect the common template pattern in a set of strings.
 * Returns the shared prefix + "{variable}" + shared suffix.
 *
 * e.g. ["Swap SOL to USDC | Jupiter", "Swap BONK to USDT | Jupiter"]
 *   → "Swap {…} | Jupiter"
 */
function detectPattern(strings) {
  if (strings.length < 2) return strings[0] || null;

  // Find longest common prefix
  let prefix = '';
  for (let i = 0; i < strings[0].length; i++) {
    const char = strings[0][i];
    if (strings.every(s => s[i] === char)) {
      prefix += char;
    } else break;
  }

  // Find longest common suffix (reversed)
  const reversed = strings.map(s => s.split('').reverse().join(''));
  let suffix = '';
  for (let i = 0; i < reversed[0].length; i++) {
    const char = reversed[0][i];
    if (reversed.every(s => s[i] === char)) {
      suffix = char + suffix;
    } else break;
  }

  // Don't overlap
  if (prefix.length + suffix.length >= strings[0].length) {
    return strings[0]; // all identical
  }

  const variable = prefix.length > 0 || suffix.length > 0;
  if (!variable) return null; // no common pattern

  return (prefix.trim() + ' {…} ' + suffix.trim()).trim();
}
