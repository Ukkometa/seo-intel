const SAFE_JSON_FALLBACK = [];

export function parseJson(value, fallback = SAFE_JSON_FALLBACK) {
  if (value == null || value === '') return Array.isArray(fallback) ? [...fallback] : fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return Array.isArray(fallback) ? [...fallback] : fallback;
  }
}

export function getProjectDomains(db, project) {
  return db.prepare(`
    SELECT id, domain, role
    FROM domains
    WHERE project = ?
    ORDER BY CASE role WHEN 'target' THEN 0 WHEN 'owned' THEN 1 ELSE 2 END, domain
  `).all(project);
}

export function getTargetDomains(domains) {
  return domains.filter(d => d.role === 'target' || d.role === 'owned');
}

export function getCompetitorDomains(domains, vsDomain = null) {
  return domains.filter(d => d.role === 'competitor' && (!vsDomain || d.domain === vsDomain));
}

export function getProjectPageCount(db, project) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ?
  `).get(project)?.count || 0;
}

export function assertHasCrawlData(db, project) {
  const count = getProjectPageCount(db, project);
  if (!count) {
    const err = new Error('No crawl data found. Run `crawl` first.');
    err.code = 'NO_CRAWL_DATA';
    throw err;
  }
  return count;
}

export function getLatestAnalysis(db, project) {
  const row = db.prepare(`
    SELECT *
    FROM analyses
    WHERE project = ?
    ORDER BY generated_at DESC
    LIMIT 1
  `).get(project);

  if (!row) return null;

  return {
    ...row,
    keyword_gaps: parseJson(row.keyword_gaps, []),
    content_gaps: parseJson(row.content_gaps, []),
    technical_gaps: parseJson(row.technical_gaps, []),
    new_pages: parseJson(row.new_pages, []),
    positioning: parseJson(row.positioning, null),
  };
}

export function getTechnicalDataset(db, project) {
  return db.prepare(`
    SELECT
      p.id,
      p.url,
      p.status_code,
      p.word_count,
      p.click_depth,
      p.is_indexable,
      d.domain,
      d.role,
      COALESCE(e.meta_desc, '') AS meta_desc,
      COALESCE(e.h1, '') AS h1,
      COALESCE(t.has_canonical, 0) AS has_canonical,
      COALESCE(t.has_og_tags, 0) AS has_og_tags,
      COALESCE(t.has_schema, 0) AS has_schema,
      COALESCE((SELECT COUNT(*) FROM page_schemas ps WHERE ps.page_id = p.id), 0) AS schema_count,
      COALESCE((SELECT COUNT(*) FROM page_schemas ps WHERE ps.page_id = p.id AND LOWER(ps.schema_type) = 'breadcrumblist'), 0) AS breadcrumb_count,
      COALESCE((SELECT COUNT(*) FROM headings h WHERE h.page_id = p.id AND h.level = 1), 0) AS h1_count,
      COALESCE((
        SELECT COUNT(*)
        FROM links l
        JOIN pages src ON src.id = l.source_id
        JOIN domains srcd ON srcd.id = src.domain_id
        WHERE srcd.project = d.project
          AND l.is_internal = 1
          AND l.target_url = p.url
      ), 0) AS inbound_internal_links,
      COALESCE((
        SELECT COUNT(*)
        FROM pages child
        JOIN domains childd ON childd.id = child.domain_id
        WHERE childd.project = d.project
          AND child.status_code BETWEEN 300 AND 399
          AND EXISTS (
            SELECT 1 FROM links l2 WHERE l2.source_id = p.id AND l2.target_url = child.url
          )
      ), 0) AS redirects_linked_from_page
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
    LEFT JOIN technical t ON t.page_id = p.id
    LEFT JOIN extractions e ON e.page_id = p.id
    WHERE d.project = ?
      AND d.role IN ('target', 'owned')
    ORDER BY d.role, d.domain, p.click_depth, p.url
  `).all(project);
}

export function getSchemaCoverage(db, project, vsDomain = null) {
  const params = [project];
  let competitorFilter = '';
  if (vsDomain) {
    competitorFilter = ' AND (d.role != \'competitor\' OR d.domain = ?)';
    params.push(vsDomain);
  }

  return db.prepare(`
    SELECT
      ps.schema_type,
      d.domain,
      d.role,
      COUNT(*) AS count,
      COUNT(DISTINCT p.id) AS page_count
    FROM page_schemas ps
    JOIN pages p ON p.id = ps.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ?
      ${competitorFilter}
    GROUP BY ps.schema_type, d.domain, d.role
    ORDER BY ps.schema_type, d.role, count DESC
  `).all(...params);
}

export function getEntityCoverage(db, project, vsDomain = null) {
  const params = [project];
  let competitorFilter = '';
  if (vsDomain) {
    competitorFilter = ' AND (d.role != \'competitor\' OR d.domain = ?)';
    params.push(vsDomain);
  }

  return db.prepare(`
    SELECT e.primary_entities, p.url, d.domain, d.role
    FROM extractions e
    JOIN pages p ON p.id = e.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ?
      ${competitorFilter}
  `).all(...params);
}

export function getHeadingClusterDataset(db, project, vsDomain = null) {
  const params = [project];
  let competitorFilter = '';
  if (vsDomain) {
    competitorFilter = ' AND (d.role != \'competitor\' OR d.domain = ?)';
    params.push(vsDomain);
  }

  return db.prepare(`
    SELECT h.level, h.text, p.url, p.word_count, d.domain, d.role
    FROM headings h
    JOIN pages p ON p.id = h.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ?
      AND h.level IN (1, 2, 3)
      ${competitorFilter}
    ORDER BY d.role, d.domain, p.url, h.level
  `).all(...params);
}

export function getPagePatternDataset(db, project, vsDomain = null) {
  const params = [project];
  let competitorFilter = '';
  if (vsDomain) {
    competitorFilter = ' AND (d.role != \'competitor\' OR d.domain = ?)';
    params.push(vsDomain);
  }

  return db.prepare(`
    SELECT p.url, p.word_count, p.click_depth, d.domain, d.role
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ?
      ${competitorFilter}
    ORDER BY d.role, d.domain, p.url
  `).all(...params);
}
