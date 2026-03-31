/**
 * Content Similarity & DOM Fingerprinting — Phase 2 utilities
 *
 * Pure functions for measuring how "samey" template pages are.
 */

/**
 * Jaccard similarity on 3-word shingles.
 * Returns 0.0–1.0 where 1.0 = identical text.
 *
 * @param {string} textA
 * @param {string} textB
 * @returns {number}
 */
export function textSimilarity(textA, textB) {
  if (!textA || !textB) return 0;

  const shinglesA = wordShingles(textA, 3);
  const shinglesB = wordShingles(textB, 3);

  if (shinglesA.size === 0 && shinglesB.size === 0) return 1;
  if (shinglesA.size === 0 || shinglesB.size === 0) return 0;

  let intersection = 0;
  for (const s of shinglesA) {
    if (shinglesB.has(s)) intersection++;
  }

  const union = shinglesA.size + shinglesB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Build a Set of 3-word shingles from text.
 */
function wordShingles(text, n) {
  const words = text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 1);
  const shingles = new Set();
  for (let i = 0; i <= words.length - n; i++) {
    shingles.add(words.slice(i, i + n).join(' '));
  }
  return shingles;
}

/**
 * Compute average pairwise similarity across an array of texts.
 * Samples if array is large to avoid O(n²) explosion.
 *
 * @param {string[]} texts
 * @param {number} maxPairs — max pairs to compare (default 50)
 * @returns {number} 0.0–1.0
 */
export function averageSimilarity(texts, maxPairs = 50) {
  const valid = texts.filter(t => t && t.length > 20);
  if (valid.length < 2) return 0;

  // Build all pair indices, then sample
  const pairs = [];
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      pairs.push([i, j]);
    }
  }

  // Shuffle and take maxPairs
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  const selected = pairs.slice(0, maxPairs);

  let totalSim = 0;
  for (const [i, j] of selected) {
    totalSim += textSimilarity(valid[i], valid[j]);
  }

  return totalSim / selected.length;
}

/**
 * Compute DOM fingerprint from a Playwright page.
 * Returns a compact sorted string: "div:142,p:38,span:91,..."
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
export async function domFingerprint(page) {
  const counts = await page.evaluate(() => {
    const acc = {};
    for (const el of document.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase();
      acc[tag] = (acc[tag] || 0) + 1;
    }
    return acc;
  });

  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, count]) => `${tag}:${count}`)
    .join(',');
}

/**
 * Cosine similarity between two DOM fingerprint strings.
 * Returns 0.0–1.0.
 *
 * @param {string} fpA
 * @param {string} fpB
 * @returns {number}
 */
export function fingerprintSimilarity(fpA, fpB) {
  if (!fpA || !fpB) return 0;

  const vecA = parseFingerprint(fpA);
  const vecB = parseFingerprint(fpB);

  const allTags = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);

  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  for (const tag of allTags) {
    const a = vecA[tag] || 0;
    const b = vecB[tag] || 0;
    dotProduct += a * b;
    magA += a * a;
    magB += b * b;
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  return magnitude > 0 ? dotProduct / magnitude : 0;
}

/**
 * Average pairwise DOM fingerprint similarity.
 *
 * @param {string[]} fingerprints
 * @param {number} maxPairs
 * @returns {number}
 */
export function averageFingerprintSimilarity(fingerprints, maxPairs = 50) {
  const valid = fingerprints.filter(Boolean);
  if (valid.length < 2) return 0;

  const pairs = [];
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      pairs.push([i, j]);
    }
  }

  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  const selected = pairs.slice(0, maxPairs);

  let total = 0;
  for (const [i, j] of selected) {
    total += fingerprintSimilarity(valid[i], valid[j]);
  }

  return total / selected.length;
}

function parseFingerprint(fp) {
  const vec = {};
  for (const part of fp.split(',')) {
    const [tag, count] = part.split(':');
    if (tag && count) vec[tag] = parseInt(count) || 0;
  }
  return vec;
}
