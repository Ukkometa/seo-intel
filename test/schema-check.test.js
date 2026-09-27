/**
 * Schema dialects and the client-side check — validate() on the plain
 * dialect (types, required, closed objects, enums, nullable types, nested
 * arrays, limits inside and outside the schema), the four provider
 * transforms on one judgment-shaped schema, and extractJson on the ways a
 * model wraps its answer in prose.
 *
 * Nothing here touches a provider: every transform is a pure function on a
 * fixture and every check runs on values built in this file.
 */
import assert from 'node:assert/strict';
import {
  LIMIT_KEYWORDS,
  extractJson,
  forAnthropic,
  forGemini,
  forOllama,
  forOpenAI,
  validate,
} from '../lib/schema-check.js';

// ── A judgment-shaped schema, in the plain dialect ──────────────────────────
const JUDGMENT = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      description: 'one row per query',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['keyword', 'intent', 'score', 'kind'],
        properties: {
          keyword: { type: 'string', description: 'the query as written' },
          intent: { type: 'string', enum: ['informational', 'commercial', 'transactional', 'navigational'] },
          score: { type: 'integer' },
          kind: { const: 'gap' },
          note: { type: ['string', 'null'] },
          page: { type: 'string' },
        },
      },
    },
    summary: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
};
const LIMITS = {
  items: { maxItems: 3 },
  'items.keyword': { minLength: 1, maxLength: 20 },
  'items.score': { minimum: 0, maximum: 100 },
};
const row = (over = {}) => ({ keyword: 'seo tool', intent: 'commercial', score: 80, kind: 'gap', note: null, ...over });

// ── validate: accepts ───────────────────────────────────────────────────────
{
  const r = validate(JUDGMENT, { items: [row(), row({ note: 'ok', page: '/x' })], summary: 'fine' }, LIMITS);
  assert.deepEqual(r, { ok: true, errors: [] }, 'a well-formed judgment passes');
  assert.equal(validate(JUDGMENT, { items: [] }).ok, true, 'optional summary may be absent');
  assert.equal(validate(JUDGMENT, { items: [], summary: null }).ok, true, 'anyOf null branch matches');
  assert.equal(validate({ type: ['integer', 'null'] }, null).ok, true, 'a nullable root');
  assert.equal(validate({ type: 'integer' }, 3).ok, true);
  assert.equal(validate({ type: 'number' }, 3.5).ok, true);
  assert.equal(validate({ type: 'string', nullable: true }, null).ok, true, "Gemini's nullable spelling is honoured");
}

// ── validate: rejects, with a path on every error ───────────────────────────
{
  const r = validate(JUDGMENT, { items: [row({ score: '80' })] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['$.items[0].score: expected integer, got string']);

  assert.deepEqual(validate({ type: 'integer' }, 1.5).errors, ['$: expected integer, got number']);

  const missing = validate(JUDGMENT, { items: [{ keyword: 'a', score: 1, kind: 'gap' }] });
  assert.deepEqual(missing.errors, ['$.items[0]: missing required property "intent"']);

  const extra = validate(JUDGMENT, { items: [row({ bonus: true })] });
  assert.deepEqual(extra.errors, ['$.items[0].bonus: unexpected property']);

  const badEnum = validate(JUDGMENT, { items: [row({ intent: 'other' })] });
  assert.equal(badEnum.errors.length, 1);
  assert.match(badEnum.errors[0], /^\$\.items\[0\]\.intent: expected one of \[.*"commercial".*\], got "other"$/);

  const badConst = validate(JUDGMENT, { items: [row({ kind: 'win' })] });
  assert.deepEqual(badConst.errors, ['$.items[0].kind: expected "gap", got "win"']);

  const badNullable = validate(JUDGMENT, { items: [row({ note: 5 })] });
  assert.deepEqual(badNullable.errors, ['$.items[0].note: expected string|null, got integer']);

  const badAnyOf = validate(JUDGMENT, { items: [], summary: 5 });
  assert.deepEqual(badAnyOf.errors, ['$.summary: matches none of the 2 anyOf branches']);

  assert.deepEqual(validate(JUDGMENT, []).errors, ['$: expected object, got array']);
  assert.deepEqual(validate(JUDGMENT, { items: {} }).errors, ['$.items: expected array, got object']);

  // several problems are all reported, not just the first
  const many = validate(JUDGMENT, { items: [row({ score: 'x' }), row({ intent: 'nope' })], summary: 1 });
  assert.equal(many.errors.length, 3);
}

// ── validate: nested arrays ─────────────────────────────────────────────────
{
  const grid = { type: 'array', items: { type: 'array', items: { type: 'integer' } } };
  assert.equal(validate(grid, [[1, 2], [3]]).ok, true);
  assert.deepEqual(validate(grid, [[1, 'two'], [3]]).errors, ['$[0][1]: expected integer, got string']);
  // indices are not part of the limit key: 'cells' limits every inner array and every number
  const named = { type: 'object', properties: { cells: grid }, required: ['cells'], additionalProperties: false };
  const r = validate(named, { cells: [[1, 2, 3], [200]] }, { cells: { maxItems: 2, maximum: 100 } });
  assert.deepEqual(r.errors, ['$.cells[0]: more than 2 items', '$.cells[1][0]: above maximum 100']);
}

// ── validate: limits outside the schema ─────────────────────────────────────
{
  const tooMany = validate(JUDGMENT, { items: [row(), row(), row(), row()] }, LIMITS);
  assert.deepEqual(tooMany.errors, ['$.items: more than 3 items']);

  const bounds = validate(JUDGMENT, { items: [row({ keyword: '' }), row({ keyword: 'x'.repeat(21), score: 101 })] }, LIMITS);
  assert.deepEqual(bounds.errors, [
    '$.items[0].keyword: shorter than 1 characters',
    '$.items[1].keyword: longer than 20 characters',
    '$.items[1].score: above maximum 100',
  ]);
  assert.deepEqual(validate(JUDGMENT, { items: [row({ score: -1 })] }, LIMITS).errors, ['$.items[0].score: below minimum 0']);
  assert.deepEqual(validate({ type: 'array', items: { type: 'string' } }, [], { '': { minItems: 1 } }).errors, ['$: fewer than 1 items'], 'the root key is the empty string');
  assert.equal(validate(JUDGMENT, { items: [row()] }, undefined).ok, true, 'limits may be omitted');
}

// ── validate: limits left inside the schema are honoured too ───────────────
{
  const s = { type: 'object', additionalProperties: false, required: ['tag'], properties: { tag: { type: 'string', maxLength: 3 } } };
  assert.deepEqual(validate(s, { tag: 'abcd' }).errors, ['$.tag: longer than 3 characters']);
  assert.equal(validate(s, { tag: 'abc' }).ok, true);
}

// ── Fixture with limits written into the schema (what the transforms strip) ─
const WITH_LIMITS = structuredClone(JUDGMENT);
WITH_LIMITS.properties.items.maxItems = 40;
WITH_LIMITS.properties.items.items.properties.keyword.minLength = 1;
WITH_LIMITS.properties.items.items.properties.keyword.maxLength = 80;
WITH_LIMITS.properties.items.items.properties.score.minimum = 0;
WITH_LIMITS.properties.items.items.properties.score.maximum = 100;

function hasAnyKey(node, keys, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) { node.forEach(n => hasAnyKey(n, keys, found)); return found; }
  for (const [k, v] of Object.entries(node)) {
    if (keys.includes(k)) found.push(k);
    hasAnyKey(v, keys, found);
  }
  return found;
}

// ── forAnthropic ────────────────────────────────────────────────────────────
{
  const before = structuredClone(WITH_LIMITS);
  const a = forAnthropic(WITH_LIMITS);
  assert.deepEqual(WITH_LIMITS, before, 'the input schema is not mutated');

  assert.equal(a.additionalProperties, false);
  assert.deepEqual(a.required, ['items', 'summary'], 'every root property becomes required');
  assert.deepEqual(a.properties.summary.anyOf, [{ type: 'string' }, { type: 'null' }], 'an anyOf that already allows null is left alone');

  const item = a.properties.items.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.required, ['keyword', 'intent', 'score', 'kind', 'note', 'page']);
  assert.deepEqual(item.properties.page.type, ['string', 'null'], 'a formerly optional property becomes nullable');
  assert.deepEqual(item.properties.note.type, ['string', 'null'], 'an already nullable type is not doubled');
  assert.equal(item.properties.keyword.type, 'string', 'a required property keeps its type');
  assert.deepEqual(item.properties.kind, { const: 'gap' }, 'a required const is kept');
  assert.equal(item.properties.keyword.description, 'the query as written', 'descriptions survive');
  assert.deepEqual(hasAnyKey(a, LIMIT_KEYWORDS), [], 'no limit keyword leaves the machine');

  // an optional enum gets null in both the type and the enum; an optional const becomes a two-value enum
  const opt = forAnthropic({ type: 'object', properties: { a: { type: 'string', enum: ['x', 'y'] }, b: { const: 'k' } }, required: [] });
  assert.deepEqual(opt.properties.a, { type: ['string', 'null'], enum: ['x', 'y', null] });
  assert.deepEqual(opt.properties.b, { enum: ['k', null] });
  assert.deepEqual(opt.required, ['a', 'b']);

  // an object that never listed required
  const bare = forAnthropic({ type: 'object', properties: { n: { type: 'integer' } } });
  assert.deepEqual(bare, { type: 'object', additionalProperties: false, required: ['n'], properties: { n: { type: ['integer', 'null'] } } });
}

// ── forOpenAI: strict mode has the same rules ───────────────────────────────
assert.deepEqual(forOpenAI(WITH_LIMITS), forAnthropic(WITH_LIMITS));

// ── forGemini ───────────────────────────────────────────────────────────────
{
  const before = structuredClone(WITH_LIMITS);
  const g = forGemini(WITH_LIMITS);
  assert.deepEqual(WITH_LIMITS, before, 'the input schema is not mutated');

  assert.deepEqual(hasAnyKey(g, ['additionalProperties', 'const', 'anyOf', '$ref', ...LIMIT_KEYWORDS]), [], 'nothing Gemini rejects survives');
  assert.equal(g.type, 'object');
  assert.deepEqual(g.required, ['items']);
  assert.deepEqual(g.properties.summary, { type: 'string', nullable: true }, 'anyOf [string, null] collapses to a nullable string');
  assert.equal(g.properties.items.type, 'array');
  assert.equal(g.properties.items.description, 'one row per query');

  const item = g.properties.items.items;
  assert.equal(item.type, 'object');
  assert.deepEqual(item.required, ['keyword', 'intent', 'score', 'kind']);
  assert.deepEqual(item.properties.note, { type: 'string', nullable: true }, "['string','null'] becomes the base type plus nullable");
  assert.deepEqual(item.properties.kind, { type: 'string', enum: ['gap'] }, 'a string const becomes a one-value enum');
  assert.deepEqual(item.properties.intent, { type: 'string', enum: ['informational', 'commercial', 'transactional', 'navigational'] });
  assert.deepEqual(item.properties.score, { type: 'integer' });
  assert.deepEqual(item.properties.keyword, { type: 'string', description: 'the query as written' });

  assert.deepEqual(forGemini({ type: 'integer', enum: [1, 2] }), { type: 'string', enum: ['1', '2'] }, 'enum values are stringified');
  assert.deepEqual(forGemini({ type: 'string', enum: ['a', null] }), { type: 'string', enum: ['a'], nullable: true }, 'a null enum member becomes nullable');
  assert.deepEqual(forGemini({ type: ['string', 'number'] }), { type: 'string' }, 'a union of base types keeps the first');
  assert.deepEqual(forGemini({ const: 7 }), {}, 'a non-string const is dropped');
  assert.deepEqual(forGemini({ description: 'd', anyOf: [{ type: 'null' }, { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }] }),
    { type: 'object', nullable: true, description: 'd', properties: { a: { type: 'string' } }, required: ['a'] },
    'anyOf collapses to its first non-null branch and keeps the wrapper description');
}

// ── forOllama ───────────────────────────────────────────────────────────────
{
  const before = structuredClone(WITH_LIMITS);
  const o = forOllama(WITH_LIMITS);
  assert.deepEqual(WITH_LIMITS, before, 'the input schema is not mutated');
  assert.deepEqual(o, JUDGMENT, 'only the limit keywords are removed; the plain dialect is what Ollama takes');
}

// ── extractJson ─────────────────────────────────────────────────────────────
{
  assert.deepEqual(extractJson('```json\n{"a": 1}\n```'), { a: 1 }, 'a json code fence');
  assert.deepEqual(extractJson('```\n[1, 2]\n```'), [1, 2], 'a bare code fence');
  assert.deepEqual(extractJson('Here is the result:\n{"a": [1, 2]}\nHope this helps.'), { a: [1, 2] }, 'leading prose and trailing text');
  assert.deepEqual(extractJson('[1,2,3] and then some { unbalanced'), [1, 2, 3], 'trailing junk after an array');
  assert.deepEqual(extractJson('Use {curly} braces, then {"ok": true}.'), { ok: true }, 'a brace in prose is skipped');
  assert.deepEqual(extractJson('{"s": "}{", "t": "\\"quoted\\""}'), { s: '}{', t: '"quoted"' }, 'brackets and escapes inside strings do not count');
  assert.deepEqual(extractJson('Sure! ```json\n{"items": []}\n``` Let me know.'), { items: [] }, 'a fence in the middle of prose');
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('{ broken'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
  assert.equal(extractJson(undefined), null);
}

console.log('schema-check: all tests passed');
