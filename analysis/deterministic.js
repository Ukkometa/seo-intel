/**
 * analysis/deterministic.js — the parts of the competitive analysis that are
 * arithmetic over crawl rows, taken away from the model.
 *
 * The old analysis handed one model a single prompt with seven tasks and the
 * whole keyword matrix, and asked it to count, cluster, audit and strategise
 * in one breath. Three of those tasks were never judgment calls. Which
 * keywords competitors use and the target does not is a set difference over
 * the keywords table. Which schema types competitors publish and the target
 * does not is a set difference over page_schemas. Which pages have no title
 * is a column that is NULL. A model asked to do those alongside the real
 * judgments did them worse than a loop would — it dropped keywords, rounded
 * counts, and when the data ran thin it filled the gaps with domains it had
 * not been shown. Every consumer downstream (the Ledger, the dashboard, the
 * exports) then treated those inventions as findings.
 *
 * So the counting lives here, as pure functions over the row shapes db/db.js
 * already returns (getKeywordMatrix, getHeadingStructure, getSchemasByProject,
 * getActiveInsights), and the model is left with what only a model can do:
 * name the intent of a keyword, say why a topic matters, propose a page. The
 * split also fixes provenance. What comes out of here is a fact about the
 * crawl and can be re-derived from the same rows; what comes out of
 * analysis/judgments.js is a hypothesis with a prompt version stamped on it.
 * The item shapes match what analysis/prompt-builder.js asked the model for,
 * field for field, so exports/competitive.js, lib/scan-export.js,
 * reports/generate-html.js and db/db.js _insightFingerprint keep working on
 * the mixed output without knowing which half produced an item.
 *
 * Two functions read the database rather than take rows — demandSections and
 * technicalGaps — because their inputs are the Ledger and the technical
 * audit, not a table. Both tolerate a database that predates the tables they
 * read: an analysis of a fresh project must degrade to "nothing measured",
 * not throw.
 *
 * Text handling in contentGapClusters is deliberately naive: lower-case,
 * stopwords out, a suffix-trimming stem. It groups "Webhook streaming" with
 * "Webhooks for wallets" and that is all it needs to do; the model names the
 * topic afterwards. A real stemmer would be a dependency for a gain nobody
 * would see in the output.
 */

import { getActiveInsights, getSchemasByProject } from '../db/db.js';
import { runTechnicalAudit } from './technical-audit.js';

// ── Shared helpers ──────────────────────────────────────────────────────────

const normDomain = d => String(d || '').trim().toLowerCase().replace(/^www\./, '');
const normKeyword = k => String(k || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The target's rows are the configured target domain plus anything crawled
 * under the 'owned' role: getCompetitorSummary merges those the same way,
 * because a target that redirects to www. lands its pages under 'owned' and
 * would otherwise look like it covers nothing.
 */
function isTargetRow(row, domain, target) {
  if (target && domain === target) return true;
  return row?.role === 'target' || row?.role === 'owned';
}

/**
 * With a competitor list, only those domains count — a competitor removed
 * from the config but still in the database must not resurface. Without a
 * list, the role column decides.
 */
function isCompetitorRow(row, domain, competitorSet) {
  if (competitorSet.size) return competitorSet.has(domain);
  return row?.role === 'competitor';
}

// ── Keyword gaps ────────────────────────────────────────────────────────────

/**
 * Keywords competitors use that the target does not. PURE.
 *
 * A single word covered by two competitors is usually noise ("solana",
 * "pricing"): every site in a niche shares its vocabulary, and a one-word
 * "gap" tells the target nothing it can act on. Multi-word keywords are kept
 * at the minCompetitors floor; single words need three competitors before
 * they count, at which point the word is a theme the target is missing rather
 * than a shared noun.
 *
 * `frequency` is the summed competitor freq across the domains that cover the
 * keyword; it breaks ties between keywords with the same coverage so the
 * order is stable run to run.
 *
 * @param {{ keyword: string, domain: string, role?: string, location?: string, freq?: number }[]} matrixRows
 * @param {{ targetDomain: string, competitorDomains?: string[], minCompetitors?: number, limit?: number }} opts
 * @returns {{ keyword: string, competitor_count: number, covered_by: string[], frequency: number }[]}
 */
export function keywordGapsFromMatrix(matrixRows, { targetDomain, competitorDomains = [], minCompetitors = 2, limit = 60 } = {}) {
  const target = normDomain(targetDomain);
  const competitorSet = new Set((competitorDomains || []).map(normDomain).filter(Boolean));
  const targetKeywords = new Set();
  const byKeyword = new Map();

  for (const row of matrixRows || []) {
    const keyword = normKeyword(row?.keyword);
    if (!keyword) continue;
    const domain = normDomain(row.domain);
    if (isTargetRow(row, domain, target)) { targetKeywords.add(keyword); continue; }
    if (!isCompetitorRow(row, domain, competitorSet)) continue;
    const entry = byKeyword.get(keyword) || { domains: new Set(), frequency: 0 };
    entry.domains.add(domain);
    entry.frequency += Number(row.freq) || 0;
    byKeyword.set(keyword, entry);
  }

  const singleWordFloor = Math.max(3, minCompetitors);
  const out = [];
  for (const [keyword, entry] of byKeyword) {
    if (targetKeywords.has(keyword)) continue;
    const count = entry.domains.size;
    const multiWord = keyword.includes(' ');
    if (count < minCompetitors) continue;
    if (!multiWord && count < singleWordFloor) continue;
    out.push({
      keyword,
      competitor_count: count,
      covered_by: [...entry.domains].sort(),
      frequency: entry.frequency,
    });
  }

  out.sort((a, b) => b.competitor_count - a.competitor_count
    || b.frequency - a.frequency
    || a.keyword.localeCompare(b.keyword));
  return out.slice(0, limit);
}

// ── Content gap clusters ────────────────────────────────────────────────────

/**
 * Function words plus the chrome every site's headings share (navigation,
 * legal, "learn more"). A gap keyed on "contact" or "latest" is not a gap.
 * Product nouns like pricing, docs or support are kept on purpose: a
 * competitor with a Pricing H1 when the target has none is a real finding.
 */
const STOPWORDS = new Set(`
a about above after again against all also although always among an and any are around as at
be because been before being below between both but by can cannot could did do does doing done
down during each either else ever every few for from further get gets getting got had has have
having he her here hers herself him himself his how however i if in into is it its itself just
keep keeps let lets like made make makes making many may me might mine more most much must my
myself near need needs neither never next no nor not nothing now of off often on once one only
onto or other others ought our ours ourselves out over own per rather same several shall she
should since so some something still such than that the their theirs them themselves then there
therefore these they this those though through thus to too toward towards under until up upon us
use used uses using very via was we were what whatever when whenever where whether which while who
whom whose why will with within without would yes yet you your yours yourself yourselves
home contact login logout signup sign menu cookie cookies privacy terms policy legal
learn read click back previous page pages share follow subscribe newsletter search
related latest recent popular footer header navigation skip main toggle copyright rights reserved
welcome thank thanks email address phone company team careers jobs blog news overview introduction
conclusion summary table contents started start free best top new
`.split(/\s+/).filter(Boolean));

/**
 * Suffix trimming, not stemming: enough to fold plurals and -ing/-ed forms of
 * the same noun together. Wrong on plenty of words (managed → manag) and
 * consistently wrong, which is what grouping needs.
 */
export function stemToken(word) {
  const w = String(word || '');
  if (w.length >= 5 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length >= 6 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length >= 5 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length >= 5 && w.endsWith('es') && /[sxzh]es$/.test(w)) return w.slice(0, -2);
  if (w.length >= 5 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/**
 * Content tokens of a heading: lower-case words of four letters or more that
 * are not stopwords and not numbers, each with its stem. Duplicated stems
 * within one heading are kept once — "Webhooks and webhook retries" is one
 * webhook, not two.
 *
 * @returns {{ word: string, stem: string }[]}
 */
export function headingTokens(text) {
  const seen = new Set();
  const out = [];
  for (const word of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < 4 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    const stem = stemToken(word);
    if (seen.has(stem)) continue;
    seen.add(stem);
    out.push({ word, stem });
  }
  return out;
}

/**
 * Up to `max` sample headings spread across domains: one from each domain in
 * turn, so a cluster three competitors share does not show five headings
 * from the first.
 */
function spreadSamples(headings, max) {
  const byDomain = new Map();
  for (const h of headings) {
    if (!byDomain.has(h.domain)) byDomain.set(h.domain, []);
    byDomain.get(h.domain).push(h.text);
  }
  const queues = [...byDomain.keys()].sort().map(d => byDomain.get(d));
  const out = [];
  for (let i = 0; out.length < max && queues.some(q => q.length); i++) {
    for (const q of queues) {
      if (out.length >= max) break;
      if (q.length) out.push(q.shift());
    }
  }
  return out;
}

/**
 * Competitor H1/H2 topics the target's headings do not cover, grouped by
 * their most shared term. PURE.
 *
 * A competitor heading is uncovered when fewer than half of its content
 * tokens appear anywhere in the target's headings (all levels — a topic the
 * target only reaches in an H3 is still reached). Each uncovered heading is
 * filed under the uncovered token that most uncovered headings share, so
 * "Webhook streaming", "Webhooks for wallets" and "Webhook retries" become
 * one cluster keyed "webhook". The key_term is the most frequent surface
 * form of that stem, so a reader sees "webhooks" rather than "webhook" when
 * that is what the sites say.
 *
 * A cluster must be covered by two competitor domains unless there is only
 * one competitor: with several competitors, one site's idiosyncratic heading
 * is not a market pattern; with one competitor it is the only evidence there
 * is. Headings are deduplicated per domain and text, so a sitewide H2 counts
 * once per site.
 *
 * @param {{ domain: string, role?: string, level: number, text: string }[]} headingRows
 * @param {{ targetDomain: string, competitorDomains?: string[], limit?: number }} opts
 * @returns {{ key_term: string, sample_headings: string[], covered_by: string[], heading_count: number }[]}
 */
export function contentGapClusters(headingRows, { targetDomain, competitorDomains = [], limit = 15 } = {}) {
  const target = normDomain(targetDomain);
  const competitorSet = new Set((competitorDomains || []).map(normDomain).filter(Boolean));
  const targetStems = new Set();
  const competitorHeadings = [];
  const seenHeading = new Set();
  const seenDomains = new Set();

  for (const row of headingRows || []) {
    const text = String(row?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const domain = normDomain(row.domain);
    if (isTargetRow(row, domain, target)) {
      for (const t of headingTokens(text)) targetStems.add(t.stem);
      continue;
    }
    if (!isCompetitorRow(row, domain, competitorSet)) continue;
    if (Number(row.level) > 2) continue;
    seenDomains.add(domain);
    const dedupKey = `${domain}\u0000${text.toLowerCase()}`;
    if (seenHeading.has(dedupKey)) continue;
    seenHeading.add(dedupKey);
    const tokens = headingTokens(text);
    if (tokens.length) competitorHeadings.push({ domain, text, tokens });
  }

  const competitorCount = competitorSet.size || seenDomains.size;

  // First pass: which headings are uncovered, and how often each uncovered
  // stem occurs across them (that frequency picks the cluster key).
  const uncovered = [];
  const stemFrequency = new Map();
  const surfaceForms = new Map();
  for (const h of competitorHeadings) {
    const covered = h.tokens.filter(t => targetStems.has(t.stem)).length;
    if (covered * 2 >= h.tokens.length) continue;
    const open = h.tokens.filter(t => !targetStems.has(t.stem));
    uncovered.push({ ...h, open });
    for (const t of open) {
      stemFrequency.set(t.stem, (stemFrequency.get(t.stem) || 0) + 1);
      const forms = surfaceForms.get(t.stem) || new Map();
      forms.set(t.word, (forms.get(t.word) || 0) + 1);
      surfaceForms.set(t.stem, forms);
    }
  }

  // Second pass: file each heading under its most shared open stem.
  const clusters = new Map();
  for (const h of uncovered) {
    const [key] = h.open.slice().sort((a, b) => stemFrequency.get(b.stem) - stemFrequency.get(a.stem)
      || a.stem.localeCompare(b.stem));
    const c = clusters.get(key.stem) || { stem: key.stem, headings: [], domains: new Set() };
    c.headings.push(h);
    c.domains.add(h.domain);
    clusters.set(key.stem, c);
  }

  const out = [];
  for (const c of clusters.values()) {
    if (c.domains.size < 2 && competitorCount > 1) continue;
    const [keyTerm] = [...surfaceForms.get(c.stem).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    out.push({
      key_term: keyTerm,
      sample_headings: spreadSamples(c.headings, 5),
      covered_by: [...c.domains].sort(),
      heading_count: c.headings.length,
    });
  }

  out.sort((a, b) => b.covered_by.length - a.covered_by.length
    || b.heading_count - a.heading_count
    || a.key_term.localeCompare(b.key_term));
  return out.slice(0, limit);
}

// ── Demand sections (from the Ledger's Search Console findings) ─────────────

const winImpact = potentialClicks => potentialClicks >= 50 ? 'high' : potentialClicks >= 20 ? 'medium' : 'low';
const tailPriority = impressions => impressions >= 100 ? 'high' : impressions >= 40 ? 'medium' : 'low';

/**
 * The issue text names the kind of win without its numbers, because
 * _insightFingerprint keys a quick_win on page::issue: a position that moves
 * from 12.3 to 11.8 must update the same Ledger row, not open a second.
 */
function quickWinIssue(w) {
  const q = `"${w.query}"`;
  switch (w.kind) {
    case 'ctr_gap': return `Snippet losing clicks for ${q}`;
    case 'page_two': return `Ranking on page two for ${q}`;
    default: return `Page two and a weak snippet for ${q}`;
  }
}

/**
 * The quick_wins and long_tails sections, from what analyses/demand already
 * measured and wrote to the Ledger (gsc_quick_win, gsc_long_tail). Reads,
 * never computes: runDemand owns the thresholds. The item shapes are the
 * ones prompt-builder asked the model for, with `source: 'gsc'` so a reader
 * can tell a measured row from a model's guess, and intent/page_type left
 * null because Search Console does not know them.
 *
 * `available` is false when the Ledger holds neither kind, which is the
 * signal run-analysis uses to fall back to the model-invented long tails.
 * A database without the insights table is the same answer.
 *
 * @returns {{ available: boolean, quick_wins: object[], long_tails: object[], counts: { quick_wins: number, long_tails: number } }}
 */
export function demandSections(db, project) {
  let insights = null;
  try { insights = getActiveInsights(db, project); } catch { insights = null; }

  const quick_wins = (insights?.gsc_quick_wins || [])
    .filter(w => w?.page_url && w?.query)
    .map(w => {
      const potential = Number(w.potential_clicks) || 0;
      return {
        page: w.page_url,
        issue: quickWinIssue(w),
        fix: w.recommendation || `Improve ${w.page_url} for "${w.query}".`,
        impact: winImpact(potential),
        source: 'gsc',
        query: w.query,
        position: w.position ?? null,
        impressions: Number(w.impressions) || 0,
        potential_clicks: potential,
      };
    })
    .sort((a, b) => b.potential_clicks - a.potential_clicks || b.impressions - a.impressions || a.page.localeCompare(b.page));

  const long_tails = (insights?.gsc_long_tails || [])
    .filter(t => t?.query)
    .map(t => {
      const impressions = Number(t.impressions) || 0;
      return {
        phrase: t.query,
        intent: null,
        page_type: null,
        priority: tailPriority(impressions),
        notes: t.recommendation || `Shown ${impressions} times with no page on page one.`,
        source: 'gsc',
        impressions,
        position: t.position ?? null,
        best_page: t.best_page ?? null,
      };
    })
    .sort((a, b) => b.impressions - a.impressions || a.phrase.localeCompare(b.phrase));

  return {
    available: quick_wins.length + long_tails.length > 0,
    quick_wins,
    long_tails,
    counts: { quick_wins: quick_wins.length, long_tails: long_tails.length },
  };
}

// ── Technical gaps ──────────────────────────────────────────────────────────

/** "https://schema.org/Product", "schema:Product" and "Product" are one type. */
const normSchemaType = t => String(t || '').trim().replace(/^https?:\/\/schema\.org\//i, '').replace(/^schema:/i, '');

/**
 * Schema types at least one competitor publishes and the target does not.
 * PURE over getSchemasByProject rows. One gap per type, the fix naming the
 * JSON-LD @type so the row is actionable without a model's help.
 *
 * @param {{ domain: string, role: string, url?: string, schema_type: string }[]} schemaRows
 * @param {{ targetDomain?: string }} opts
 * @returns {{ gap: string, fix: string, competitors_with_it: string[], schema_type: string, source: 'rule' }[]}
 */
export function schemaTypeGaps(schemaRows, { targetDomain } = {}) {
  const target = normDomain(targetDomain);
  const targetTypes = new Set();
  const competitorTypes = new Map();
  for (const row of schemaRows || []) {
    const type = normSchemaType(row?.schema_type);
    if (!type) continue;
    const domain = normDomain(row.domain);
    if (isTargetRow(row, domain, target)) { targetTypes.add(type); continue; }
    if (row.role !== 'competitor') continue;
    const entry = competitorTypes.get(type) || { domains: new Set(), pages: new Set() };
    entry.domains.add(domain);
    if (row.url) entry.pages.add(row.url);
    competitorTypes.set(type, entry);
  }

  const out = [];
  for (const [type, entry] of competitorTypes) {
    if (targetTypes.has(type)) continue;
    const domains = [...entry.domains].sort();
    out.push({
      gap: `No ${type} schema markup`,
      fix: `Add JSON-LD with "@type": "${type}" to the target pages that describe the same thing; `
        + `${domains.length} competitor domain(s) publish it on ${entry.pages.size || 'their'} page(s).`,
      competitors_with_it: domains,
      schema_type: type,
      source: 'rule',
    });
  }
  out.sort((a, b) => b.competitors_with_it.length - a.competitors_with_it.length
    || a.schema_type.localeCompare(b.schema_type));
  return out;
}

/**
 * One row per finding kind of runTechnicalAudit. The gap text is stable and
 * the count lives in the fix and in `count`, for the same fingerprint reason
 * as quickWinIssue: technical_gap rows are keyed on `gap`.
 */
const AUDIT_KINDS = {
  title_missing: {
    gap: 'Pages without a <title>',
    fix: n => `Write a unique title under 60 characters for each of the ${n} page(s) that has none.`,
  },
  title_too_long: {
    gap: 'Titles over 60 characters',
    fix: n => `Shorten the title on ${n} page(s) so the whole of it shows in the result.`,
  },
  meta_desc_missing: {
    gap: 'Pages without a meta description',
    fix: n => `Write a meta description under 160 characters for each of the ${n} page(s) that has none.`,
  },
  meta_desc_too_long: {
    gap: 'Meta descriptions over 160 characters',
    fix: n => `Trim the meta description on ${n} page(s) to under 160 characters so it is not cut mid-sentence.`,
  },
  noindex_header: {
    gap: 'Pages served with a noindex X-Robots-Tag',
    fix: n => `Confirm the ${n} page(s) sent with noindex in the response header are meant to stay out of the index; remove the header where they are not.`,
  },
  redirect_chain: {
    gap: 'Pages reached through redirect chains',
    fix: n => `Point internal links and the sitemap at the final URL for the ${n} page(s) that redirect, and collapse multi-hop chains to one hop.`,
  },
  indexable_missing_from_sitemap: {
    gap: 'Indexable pages missing from the sitemap',
    fix: n => `Add the ${n} indexable page(s) not declared in the sitemap, or noindex the ones that should not be found.`,
  },
  sitemap_redirect: {
    gap: 'Sitemap URLs that redirect',
    fix: n => `Replace the ${n} redirecting sitemap URL(s) with their final destination.`,
  },
  sitemap_broken: {
    gap: 'Sitemap URLs that return errors',
    fix: n => `Remove or repair the ${n} sitemap URL(s) that return an error status.`,
  },
};

// Roll-ups the audit emits alongside its per-URL findings; they are not gaps.
const AUDIT_SUMMARY_KINDS = new Set(['redirect_targets_summary']);

/**
 * runTechnicalAudit findings grouped by kind. PURE.
 *
 * @param {{ type: string, url?: string, severity?: string }[]} findings
 * @returns {{ gap: string, fix: string, competitors_with_it: string[], count: number, sample_urls: string[], kind: string, source: 'rule' }[]}
 */
export function auditKindGaps(findings) {
  const byKind = new Map();
  for (const f of findings || []) {
    if (!f?.type || AUDIT_SUMMARY_KINDS.has(f.type)) continue;
    const entry = byKind.get(f.type) || { count: 0, urls: [] };
    entry.count++;
    if (f.url && entry.urls.length < 5 && !entry.urls.includes(f.url)) entry.urls.push(f.url);
    byKind.set(f.type, entry);
  }
  const out = [];
  for (const [kind, entry] of byKind) {
    const spec = AUDIT_KINDS[kind] || {
      gap: `Pages flagged ${kind.replace(/_/g, ' ')}`,
      fix: n => `Review the ${n} page(s) the technical audit flagged as ${kind.replace(/_/g, ' ')}.`,
    };
    out.push({
      gap: spec.gap,
      fix: spec.fix(entry.count),
      competitors_with_it: [],
      count: entry.count,
      sample_urls: entry.urls,
      kind,
      source: 'rule',
    });
  }
  out.sort((a, b) => b.count - a.count || a.gap.localeCompare(b.gap));
  return out;
}

/**
 * The technical_gaps section: schema types competitors have and the target
 * lacks, plus the target's own audit findings by kind. The audit is gated
 * (lib/gate.js 'extended-data'); when the gate is closed only the schema
 * half is returned, which is the free tier's honest answer rather than an
 * empty section. A database without page_schemas yields no schema gaps and
 * no error.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {{ target?: { domain?: string } }} config
 * @param {{ targetDomain?: string|null }} [opts]  the crawl's target domain, used when the config names none
 */
export async function technicalGaps(db, project, config = {}, { targetDomain: fallbackDomain = null } = {}) {
  // The configured domain, else the one the caller found in the crawl. With
  // neither, runTechnicalAudit would look up the domain "null", find nothing
  // and the audit half of this section would vanish without a word.
  const targetDomain = config?.target?.domain || fallbackDomain || null;
  let schemaRows = [];
  try { schemaRows = getSchemasByProject(db, project); } catch { schemaRows = []; }
  const gaps = schemaTypeGaps(schemaRows, { targetDomain });

  let audit = null;
  try {
    audit = await runTechnicalAudit(db, { project, domain: targetDomain });
  } catch {
    audit = null;
  }
  if (!audit || audit.gated || !Array.isArray(audit.findings)) return gaps;
  return [...gaps, ...auditKindGaps(audit.findings)];
}
