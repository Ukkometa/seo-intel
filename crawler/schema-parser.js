/**
 * JSON-LD Schema Parser
 *
 * Extracts structured data from <script type="application/ld+json"> blocks.
 * Parses @type, name, description, aggregateRating, offers, author, dates,
 * images — everything Google actually uses for rich results.
 *
 * Returns normalized objects ready for page_schemas table insertion.
 */

/**
 * Parse all JSON-LD blocks from raw HTML string.
 * Works on raw HTML (no DOM needed) — runs during crawl before Qwen extraction.
 *
 * @param {string} html - Raw HTML string
 * @returns {Array<Object>} Parsed schema objects
 */
export function parseJsonLd(html) {
  if (!html) return [];

  const blocks = extractJsonLdBlocks(html);
  const schemas = [];

  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      // Handle @graph arrays (common in Yoast, Schema.org generators)
      if (parsed['@graph'] && Array.isArray(parsed['@graph'])) {
        for (const item of parsed['@graph']) {
          const normalized = normalizeSchema(item);
          if (normalized) schemas.push(normalized);
        }
      } else if (Array.isArray(parsed)) {
        // Some sites output an array of schemas
        for (const item of parsed) {
          const normalized = normalizeSchema(item);
          if (normalized) schemas.push(normalized);
        }
      } else {
        const normalized = normalizeSchema(parsed);
        if (normalized) schemas.push(normalized);
      }
    } catch {
      // Malformed JSON-LD — skip silently
    }
  }

  return schemas;
}

/**
 * Extract raw JSON strings from <script type="application/ld+json"> tags.
 * Uses regex — no DOM parser needed.
 */
function extractJsonLdBlocks(html) {
  const regex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    const content = match[1].trim();
    if (content) blocks.push(content);
  }
  return blocks;
}

/**
 * Normalize a single JSON-LD object into a flat structure for DB storage.
 */
function normalizeSchema(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const type = resolveType(obj['@type']);
  if (!type) return null;

  const rating = extractRating(obj);
  const offers = extractOffers(obj);
  const author = extractAuthor(obj);
  const image = extractImage(obj);

  return {
    type,
    name: str(obj.name) || str(obj.headline) || null,
    description: str(obj.description) || null,
    rating: rating.value,
    ratingCount: rating.count,
    price: offers.price,
    currency: offers.currency,
    author,
    datePublished: str(obj.datePublished) || null,
    dateModified: str(obj.dateModified) || null,
    imageUrl: image,
    raw: obj,
  };
}

// ── Extractors ───────────────────────────────────────────────────────────────

function resolveType(t) {
  if (!t) return null;
  if (Array.isArray(t)) return t[0]; // take first type
  return String(t);
}

function extractRating(obj) {
  const ar = obj.aggregateRating;
  if (!ar) return { value: null, count: null };
  return {
    value: parseFloat(ar.ratingValue) || null,
    count: parseInt(ar.reviewCount || ar.ratingCount) || null,
  };
}

function extractOffers(obj) {
  const offers = obj.offers;
  if (!offers) return { price: null, currency: null };

  // Single offer
  if (offers.price !== undefined) {
    return {
      price: String(offers.price),
      currency: str(offers.priceCurrency) || null,
    };
  }

  // Offer with priceRange
  if (offers.priceRange) {
    return { price: str(offers.priceRange), currency: str(offers.priceCurrency) || null };
  }

  // AggregateOffer
  if (offers.lowPrice !== undefined || offers.highPrice !== undefined) {
    const low = offers.lowPrice ?? '?';
    const high = offers.highPrice ?? '?';
    return {
      price: `${low}-${high}`,
      currency: str(offers.priceCurrency) || null,
    };
  }

  // Array of offers — take first
  if (Array.isArray(offers) && offers.length > 0) {
    return extractOffers({ offers: offers[0] });
  }

  return { price: null, currency: null };
}

function extractAuthor(obj) {
  const author = obj.author;
  if (!author) return null;
  if (typeof author === 'string') return author;
  if (Array.isArray(author)) return author.map(a => str(a.name) || str(a)).filter(Boolean).join(', ');
  return str(author.name) || null;
}

function extractImage(obj) {
  const img = obj.image;
  if (!img) return null;
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) return typeof img[0] === 'string' ? img[0] : img[0]?.url || null;
  return str(img.url) || null;
}

function str(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  return String(v);
}
