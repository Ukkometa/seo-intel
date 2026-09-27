/**
 * lib/schema-check.js — one schema, five dialects, and the check that matters.
 *
 * Every judgment seo-intel asks a model for is described once, as a small
 * JSON Schema: an object at the root, every object closed with
 * additionalProperties: false and every property listed in required, enums
 * for closed vocabularies, arrays with items, no $ref and no recursion.
 * That dialect exists because the providers do not agree on one. Anthropic's
 * structured outputs and OpenAI's strict mode both insist on closed objects
 * with every property required and reject minimum/maximum/minLength/
 * maxLength/minItems/maxItems outright. Gemini's responseSchema is an
 * OpenAPI-style subset with no additionalProperties, no const, no anyOf and
 * its own spelling of "may be null" (nullable: true). Ollama's grammar
 * builder takes plain JSON Schema and silently ignores the limit keywords.
 * DeepSeek takes no schema at all and reads it as prose in the prompt.
 *
 * So the transforms here (forAnthropic, forOpenAI, forGemini, forOllama) are
 * the only place that knows each provider's dialect, and every one of them
 * is a deep copy: the schema a judgment module wrote is never mutated, and
 * the same object can be sent to two providers in one run.
 *
 * Why limits live outside the schema. A judgment often needs "at most 40
 * items" or "a keyword of 1-80 characters", and no provider that constrains
 * decoding will accept those keywords. The schema carries the shape; a
 * separate `limits` object carries the numbers; validate() checks both after
 * the answer arrives. Limit paths are dotted property names with array
 * indices left out, so `items.keyword` limits the keyword of every item and
 * `items` limits the array itself (minItems/maxItems) or, for an array of
 * numbers or strings, each element. The root's key is the empty string.
 * Limits written into the schema anyway are honoured by validate() and
 * stripped by the transforms, so a stray maxLength is a no-op rather than a
 * 400 from the provider.
 *
 * validate() is deliberately a small validator, not a draft-07 engine: it
 * covers exactly the keywords the dialect allows (type incl. arrays and
 * 'integer', properties, required, additionalProperties, enum, const, items,
 * anyOf with first match winning) and reports 'path: message' strings that a
 * model can act on when the answer is sent back for repair. Every error is
 * anchored at a JSON path from '$', so `$.items[3].keyword: expected string`
 * tells both the person and the repair prompt where to look.
 *
 * extractJson() is the safety net for text-only providers (the Agent
 * Harness gateway, the Gemini CLI) and for a native JSON mode that wrapped
 * its answer in a code fence anyway: it finds the first balanced {...} or
 * [...] that parses and ignores the prose around it.
 */

/**
 * Keywords no constrained-decoding provider accepts. Stripped from every
 * outgoing schema; enforced client-side by validate() instead.
 */
export const LIMIT_KEYWORDS = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'minItems', 'maxItems',
  'minProperties', 'maxProperties', 'multipleOf',
];

// ── validate ────────────────────────────────────────────────────────────────

/**
 * Check a parsed value against a schema and a limits object.
 *
 * @param {object} schema  the judgment's schema (the plain dialect)
 * @param {*} value        the parsed JSON answer
 * @param {Record<string, object>} [limits]  dotted path -> { minLength, maxLength, minimum, maximum, minItems, maxItems }
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validate(schema, value, limits = {}) {
  const errors = [];
  walk(schema, value, '$', '', errors, limits || {});
  return { ok: errors.length === 0, errors };
}

function walk(schema, value, at, key, errors, limits) {
  if (!schema || typeof schema !== 'object') return;

  // Gemini's spelling of an optional value; harmless to honour everywhere.
  if (schema.nullable === true && value === null) return;

  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) {
      const sub = [];
      walk(branch, value, at, key, sub, limits);
      if (sub.length === 0) return;
    }
    errors.push(`${at}: matches none of the ${schema.anyOf.length} anyOf branches`);
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => isType(t, value))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${describe(value)}`);
      return; // no point reading properties off a value of the wrong kind
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(e => deepEqual(e, value))) {
    errors.push(`${at}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }
  if ('const' in schema && !deepEqual(schema.const, value)) {
    errors.push(`${at}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  checkLimits({ ...pickLimits(schema), ...(limits[key] || {}) }, value, at, errors);

  if (isObject(value) && (schema.properties || schema.required || schema.additionalProperties !== undefined)) {
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${at}: missing required property "${req}"`);
    }
    for (const [k, v] of Object.entries(value)) {
      const prop = schema.properties?.[k];
      const childAt = `${at}.${k}`;
      const childKey = key ? `${key}.${k}` : k;
      if (prop) walk(prop, v, childAt, childKey, errors, limits);
      else if (schema.additionalProperties === false) errors.push(`${childAt}: unexpected property`);
      else if (isObject(schema.additionalProperties)) walk(schema.additionalProperties, v, childAt, childKey, errors, limits);
    }
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    // Indices are not part of the limit key: 'items.keyword' means every item's keyword.
    value.forEach((item, i) => walk(schema.items, item, `${at}[${i}]`, key, errors, limits));
  }
}

function isType(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return isObject(value);
    default: return false;
  }
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual(a[k], b[k]));
}

function pickLimits(schema) {
  const out = {};
  for (const k of LIMIT_KEYWORDS) if (schema[k] !== undefined) out[k] = schema[k];
  return out;
}

function checkLimits(lim, value, at, errors) {
  if (typeof value === 'string') {
    const n = [...value].length;
    if (lim.minLength !== undefined && n < lim.minLength) errors.push(`${at}: shorter than ${lim.minLength} characters`);
    if (lim.maxLength !== undefined && n > lim.maxLength) errors.push(`${at}: longer than ${lim.maxLength} characters`);
  } else if (typeof value === 'number') {
    if (lim.minimum !== undefined && value < lim.minimum) errors.push(`${at}: below minimum ${lim.minimum}`);
    if (lim.maximum !== undefined && value > lim.maximum) errors.push(`${at}: above maximum ${lim.maximum}`);
    if (lim.exclusiveMinimum !== undefined && value <= lim.exclusiveMinimum) errors.push(`${at}: must exceed ${lim.exclusiveMinimum}`);
    if (lim.exclusiveMaximum !== undefined && value >= lim.exclusiveMaximum) errors.push(`${at}: must be below ${lim.exclusiveMaximum}`);
  } else if (Array.isArray(value)) {
    if (lim.minItems !== undefined && value.length < lim.minItems) errors.push(`${at}: fewer than ${lim.minItems} items`);
    if (lim.maxItems !== undefined && value.length > lim.maxItems) errors.push(`${at}: more than ${lim.maxItems} items`);
  }
}

// ── Dialects ────────────────────────────────────────────────────────────────

function stripLimits(node) {
  for (const k of LIMIT_KEYWORDS) delete node[k];
}

/**
 * Make a property accept null. Structured-output modes have no "optional":
 * a property the judgment left out of required is kept, but the model may
 * answer null for it. The enum, when there is one, gets null too, because
 * both Anthropic and OpenAI reject a nullable type whose enum cannot be null.
 */
function allowNull(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.anyOf)) {
    if (!node.anyOf.some(b => b && b.type === 'null')) node.anyOf.push({ type: 'null' });
    return;
  }
  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.includes('null')) node.type = [...types, 'null'];
  }
  if ('const' in node) {
    node.enum = [node.const, null];
    delete node.const;
  } else if (Array.isArray(node.enum) && !node.enum.includes(null)) {
    node.enum = [...node.enum, null];
  }
}

function strictCopy(schema) {
  const out = structuredClone(schema);
  (function fix(node) {
    if (!node || typeof node !== 'object') return;
    stripLimits(node);
    const isObj = node.properties || node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'));
    if (isObj) {
      node.additionalProperties = false;
      const props = node.properties || {};
      const wasRequired = new Set(node.required || []);
      node.required = Object.keys(props);
      for (const [k, prop] of Object.entries(props)) {
        if (!wasRequired.has(k)) allowNull(prop);
        fix(prop);
      }
    }
    if (node.items && typeof node.items === 'object') fix(node.items);
    if (Array.isArray(node.anyOf)) node.anyOf.forEach(fix);
  })(out);
  return out;
}

/**
 * Anthropic structured outputs: every object closed, every property required
 * (formerly optional ones become nullable), no limit keywords.
 */
export function forAnthropic(schema) {
  return strictCopy(schema);
}

/**
 * OpenAI strict mode has the same rules as Anthropic's structured outputs,
 * so this is the same transform under the name the call site expects.
 */
export function forOpenAI(schema) {
  return strictCopy(schema);
}

/**
 * Gemini responseSchema: an OpenAPI-style subset. Only the keys Gemini
 * documents survive (type, description, nullable, enum, properties, required,
 * items, propertyOrdering). A type array with 'null' becomes the base type
 * plus nullable: true; a type array with several base types keeps the first,
 * because Gemini has no unions. anyOf collapses to its first non-null branch
 * (nullable when a null branch existed). A string const becomes a one-value
 * enum; any other const is dropped. Enum values are stringified and the
 * node typed string, since Gemini enums are strings only. validate() still
 * checks the answer against the original schema, so whatever this loses in
 * transit is caught on the way back.
 */
export function forGemini(schema) {
  return geminiNode(structuredClone(schema));
}

function geminiNode(node) {
  if (!node || typeof node !== 'object') return node;
  let n = node;

  if (Array.isArray(n.anyOf)) {
    const branches = n.anyOf.filter(b => b && b.type !== 'null');
    const hadNull = branches.length !== n.anyOf.length;
    const { anyOf, ...wrapper } = n;
    n = { ...(branches[0] || {}), ...wrapper };
    if (hadNull) n.nullable = true;
  }

  const out = {};
  let types = n.type === undefined ? [] : (Array.isArray(n.type) ? n.type : [n.type]);
  if (types.includes('null')) {
    out.nullable = true;
    types = types.filter(t => t !== 'null');
  }
  if (types.length) out.type = types[0];
  if (n.nullable === true) out.nullable = true;
  if (typeof n.description === 'string') out.description = n.description;

  if ('const' in n) {
    if (n.const === null) out.nullable = true;
    else if (typeof n.const === 'string') { out.enum = [n.const]; out.type = 'string'; }
  }
  if (Array.isArray(n.enum)) {
    const vals = n.enum.filter(v => v !== null);
    if (vals.length !== n.enum.length) out.nullable = true;
    if (vals.length) { out.enum = vals.map(String); out.type = 'string'; }
  }

  if (n.properties && typeof n.properties === 'object') {
    out.type = out.type || 'object';
    out.properties = {};
    for (const [k, v] of Object.entries(n.properties)) out.properties[k] = geminiNode(v);
    if (Array.isArray(n.required)) out.required = n.required.filter(k => k in n.properties);
    if (Array.isArray(n.propertyOrdering)) out.propertyOrdering = n.propertyOrdering.filter(k => k in n.properties);
  }
  if (n.items && typeof n.items === 'object') {
    out.type = out.type || 'array';
    out.items = geminiNode(n.items);
  }
  return out;
}

/**
 * Ollama takes plain JSON Schema as `format`; its grammar builder ignores
 * the limit keywords, so they are stripped rather than left to mislead.
 */
export function forOllama(schema) {
  const out = structuredClone(schema);
  (function fix(node) {
    if (!node || typeof node !== 'object') return;
    stripLimits(node);
    if (node.properties) Object.values(node.properties).forEach(fix);
    if (node.items && typeof node.items === 'object') fix(node.items);
    if (Array.isArray(node.anyOf)) node.anyOf.forEach(fix);
    if (isObject(node.additionalProperties)) fix(node.additionalProperties);
  })(out);
  return out;
}

// ── extractJson ─────────────────────────────────────────────────────────────

/**
 * The first balanced {...} or [...] in a string that parses as JSON, with
 * code fences removed first, or null when there is none. Prose before or
 * after the value is ignored; a brace inside prose that does not parse is
 * skipped and the scan continues.
 *
 * @param {string} text
 * @returns {object|any[]|null}
 */
export function extractJson(text) {
  if (typeof text !== 'string' || !text) return null;
  const stripped = text.replace(/```[\w-]*/g, '');
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = balancedEnd(stripped, i);
    if (end === -1) continue;
    try {
      return JSON.parse(stripped.slice(i, end + 1));
    } catch { /* a brace in prose; keep scanning */ }
  }
  return null;
}

/** Index of the bracket that closes the one at `start`, or -1. String-aware. */
function balancedEnd(s, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
