/**
 * SEO Intel — Model Recommendations
 *
 * Two-tier model system:
 *   Extraction tier: local Ollama model for structured JSON extraction during crawl
 *   Analysis tier: powerful cloud model (or large local) for strategic gap analysis
 *
 * Includes hardware-based auto-recommendation using VRAM detection from checks.js
 */

// ── Extraction Models (local, runs during crawl) ────────────────────────────
//
// The extraction task is structured JSON extraction:
//   Input:  ~1-4KB text (URL + title + headings + body excerpt)
//   Output: ~900 tokens JSON (13 fields: enums, keyword arrays, entities)
//   Complexity: low-medium — pattern matching + classification
//   Minimum viable: 4B parameters for reliable JSON output

export const EXTRACTION_MODELS = [
  {
    id: 'qwen3.5:4b',
    name: 'Qwen 3.5 4B',
    family: 'qwen3.5',
    tier: 'budget',
    vram: '~3 GB',
    minVramMB: 2500,
    speed: '~2s/page',
    quality: 'good',
    description: 'Minimum recommended. Reliable JSON extraction, decent keyword detection. Great for laptops and older GPUs.',
    recommended: false,
  },
  {
    id: 'qwen3.5:9b',
    name: 'Qwen 3.5 9B',
    family: 'qwen3.5',
    tier: 'balanced',
    vram: '~5 GB',
    minVramMB: 4500,
    speed: '~3s/page',
    quality: 'better',
    description: 'Default recommendation. Better entity detection and intent classification. Works on most modern GPUs.',
    recommended: true,
  },
  {
    id: 'qwen3.5:27b',
    name: 'Qwen 3.5 27B',
    family: 'qwen3.5',
    tier: 'quality',
    vram: '~17 GB',
    minVramMB: 15000,
    speed: '~6s/page',
    quality: 'great',
    description: 'Nuanced intent classification, better keyword quality. Needs RTX 3090+ or M-series with 24GB+.',
    recommended: false,
  },
  {
    id: 'qwen3.5:35b',
    name: 'Qwen 3.5 35B',
    family: 'qwen3.5',
    tier: 'power',
    vram: '~22 GB',
    minVramMB: 18000,
    speed: '~8s/page',
    quality: 'excellent',
    description: 'Near-cloud quality extraction. Needs RTX 3090/4090 or M2 Ultra. Overkill for most users.',
    recommended: false,
  },
  // Alternative providers
  {
    id: 'nemotron-nano:4b',
    name: 'Nemotron 3 Nano 4B',
    family: 'nemotron',
    tier: 'budget',
    vram: '~3 GB',
    minVramMB: 2500,
    speed: '~2s/page',
    quality: 'good',
    description: 'NVIDIA agentic model. Efficient extraction with tool-use training. Good alternative to Qwen 3.5 4B.',
    recommended: false,
  },
  // Legacy / fallback models (already installed by many users)
  {
    id: 'qwen3:4b',
    name: 'Qwen 3 4B (legacy)',
    family: 'qwen3',
    tier: 'budget',
    vram: '~3 GB',
    minVramMB: 2500,
    speed: '~2s/page',
    quality: 'good',
    description: 'Previous generation. Works well but Qwen 3.5 is better if you can upgrade.',
    recommended: false,
    legacy: true,
  },
  {
    id: 'qwen3:8b',
    name: 'Qwen 3 8B (legacy)',
    family: 'qwen3',
    tier: 'balanced',
    vram: '~5 GB',
    minVramMB: 4500,
    speed: '~3s/page',
    quality: 'better',
    description: 'Previous generation. Solid extraction. Qwen 3.5 recommended for new installs.',
    recommended: false,
    legacy: true,
  },
];

// ── Analysis Models (local Ollama, runs during analysis) ─────────────────────
//
// The analysis task is heavy strategic reasoning:
//   Input:  10K-100K tokens (full crawl dataset, keyword matrices, competitor data)
//   Output: structured JSON with strategic recommendations, positioning, gap analysis
//   Complexity: high — comparative reasoning across multiple domains
//   Minimum viable: 14B+ parameters for reliable strategic output
//   Cloud models (Claude, GPT-4o, DeepSeek) available via OpenClaw agent setup

export const ANALYSIS_MODELS = [
  {
    id: 'qwen3:14b',
    name: 'Qwen 3 14B',
    family: 'qwen3',
    type: 'local',
    vram: '~9 GB',
    minVramMB: 8000,
    context: '32K tokens',
    costNote: 'Free (your GPU)',
    quality: 'decent',
    recommended: false,
    description: 'Minimum viable for analysis. Handles small-medium projects. Needs RTX 3070+ or M1 Pro+.',
  },
  {
    id: 'qwen3.5:27b',
    name: 'Qwen 3.5 27B',
    family: 'qwen3.5',
    type: 'local',
    vram: '~17 GB',
    minVramMB: 15000,
    context: '32K tokens',
    costNote: 'Free (your GPU)',
    quality: 'good',
    recommended: true,
    description: 'Sweet spot for local analysis. Strong reasoning with 27.8B params. Needs RTX 3090/4080+ or M-series with 24GB+.',
  },
  {
    id: 'qwen3.5:35b',
    name: 'Qwen 3.5 35B',
    family: 'qwen3.5',
    type: 'local',
    vram: '~22 GB',
    minVramMB: 18000,
    context: '32K tokens',
    costNote: 'Free (your GPU)',
    quality: 'great',
    recommended: false,
    description: 'High quality analysis. Best Qwen 3.5 for strategic reasoning. Needs RTX 3090/4090 or M2 Ultra.',
  },
  {
    id: 'nemotron-3-super:120b',
    name: 'Nemotron 3 Super 120B',
    family: 'nemotron-3-super',
    type: 'local',
    vram: '~87 GB',
    minVramMB: 48000,
    context: '32K tokens',
    costNote: 'Free (your GPU)',
    quality: 'excellent',
    recommended: false,
    description: 'MoE — 120B total but only 12B active params. Excellent reasoning at efficient compute. Needs 64GB+ unified memory or multi-GPU.',
  },
];

// ── VRAM-Based Recommendations ──────────────────────────────────────────────

const VRAM_TIERS = [
  { maxMB: 2500,  extraction: null,          note: 'Not enough VRAM for local extraction. Use cloud or CPU mode (slow).' },
  { maxMB: 4500,  extraction: 'qwen3.5:4b',  note: 'Budget tier — Qwen 3.5 4B fits your GPU.' },
  { maxMB: 8000,  extraction: 'qwen3.5:9b',  note: 'Balanced tier — Qwen 3.5 9B recommended for best quality/speed.' },
  { maxMB: 18000, extraction: 'qwen3.5:27b', note: 'Quality tier — Qwen 3.5 27B for nuanced extraction.' },
  { maxMB: 48000, extraction: 'qwen3.5:35b', note: 'Power tier — Qwen 3.5 35B for near-cloud quality.' },
  { maxMB: Infinity, extraction: 'qwen3.5:35b', note: 'Power tier — Qwen 3.5 35B recommended. Your GPU can handle anything.' },
];

/**
 * Recommend an extraction model based on available models and VRAM.
 * Priority: prefer already-installed models that match VRAM tier.
 *
 * @param {string[]} availableModels - models currently in Ollama
 * @param {number} [vramMB] - detected VRAM in MB (0 if unknown)
 * @returns {{ model: object, installed: boolean, autoRecommended: boolean, note: string } | null}
 */
export function recommendExtractionModel(availableModels = [], vramMB = 0) {
  // Find VRAM tier
  const tier = VRAM_TIERS.find(t => vramMB <= t.maxMB) || VRAM_TIERS[VRAM_TIERS.length - 1];

  // Preferred model order (newest → legacy)
  const preferenceOrder = [
    'qwen3.5:9b', 'qwen3.5:27b', 'qwen3.5:4b', 'qwen3.5:35b',
    'qwen3:8b', 'qwen3:4b', 'qwen3.5:0.6b',
  ];

  // Filter to models that fit VRAM
  const fittingModels = EXTRACTION_MODELS.filter(m => !vramMB || vramMB >= m.minVramMB);

  // 1. Best installed model that fits VRAM
  for (const prefId of preferenceOrder) {
    const isInstalled = availableModels.some(m => m.startsWith(prefId.split(':')[0]) && m.includes(prefId.split(':')[1]));
    const modelDef = fittingModels.find(m => m.id === prefId);
    if (isInstalled && modelDef) {
      return {
        model: modelDef,
        installed: true,
        autoRecommended: modelDef.id === tier.extraction,
        note: `Already installed. ${tier.note}`,
      };
    }
  }

  // 2. VRAM-recommended model (not installed)
  if (tier.extraction) {
    const modelDef = EXTRACTION_MODELS.find(m => m.id === tier.extraction);
    if (modelDef) {
      return {
        model: modelDef,
        installed: false,
        autoRecommended: true,
        note: `Recommended for your hardware. ${tier.note}`,
      };
    }
  }

  // 3. Any installed model
  for (const prefId of preferenceOrder) {
    const isInstalled = availableModels.some(m => m.startsWith(prefId.split(':')[0]));
    const modelDef = EXTRACTION_MODELS.find(m => m.id === prefId);
    if (isInstalled && modelDef) {
      return {
        model: modelDef,
        installed: true,
        autoRecommended: false,
        note: `Installed but may be slow for your VRAM. Consider upgrading.`,
      };
    }
  }

  return null;
}

/**
 * Recommend an analysis model based on available Ollama models and VRAM.
 *
 * @param {string[]} availableModels - models currently in Ollama
 * @param {number} [vramMB] - detected VRAM in MB
 * @returns {{ model: object, installed: boolean, note: string }}
 */
export function recommendAnalysisModel(availableModels = [], vramMB = 0) {
  const preferenceOrder = [
    'qwen3.5:27b', 'qwen3.5:35b', 'qwen3:14b', 'nemotron-3-super:120b',
  ];

  // Filter to models that fit VRAM
  const fittingModels = ANALYSIS_MODELS.filter(m => !vramMB || vramMB >= m.minVramMB);

  // 1. Best installed model that fits VRAM
  for (const prefId of preferenceOrder) {
    const isInstalled = availableModels.some(m => m.startsWith(prefId.split(':')[0]) && m.includes(prefId.split(':')[1]));
    const modelDef = fittingModels.find(m => m.id === prefId);
    if (isInstalled && modelDef) {
      return {
        model: modelDef,
        installed: true,
        note: `Already installed. Ready for analysis.`,
      };
    }
  }

  // 2. VRAM-based recommendation
  let recId = 'qwen3:14b'; // default minimum
  if (vramMB >= 48000) recId = 'nemotron-3-super:120b';
  else if (vramMB >= 18000) recId = 'qwen3.5:35b';
  else if (vramMB >= 15000) recId = 'qwen3.5:27b';

  const recModel = ANALYSIS_MODELS.find(m => m.id === recId);
  if (recModel) {
    return {
      model: recModel,
      installed: false,
      note: `Recommended for your hardware. Use OpenClaw for cloud models.`,
    };
  }

  return {
    model: ANALYSIS_MODELS[0],
    installed: false,
    note: 'Minimum viable model for local analysis.',
  };
}

/**
 * Get all model recommendations for display.
 *
 * @param {string[]} availableModels - models in Ollama
 * @param {object} envKeys - { GEMINI_API_KEY: true, ... }
 * @param {number} vramMB - detected VRAM
 * @returns {{ extraction: object, analysis: object, allExtraction: object[], allAnalysis: object[] }}
 */
export function getModelRecommendations(availableModels = [], envKeys = {}, vramMB = 0) {
  return {
    extraction: recommendExtractionModel(availableModels, vramMB),
    analysis: recommendAnalysisModel(availableModels, vramMB),
    allExtraction: EXTRACTION_MODELS.map(m => ({
      ...m,
      installed: availableModels.some(am =>
        am.startsWith(m.family) && am.includes(m.id.split(':')[1])
      ),
      fitsVram: !vramMB || vramMB >= m.minVramMB,
    })),
    allAnalysis: ANALYSIS_MODELS.map(m => ({
      ...m,
      installed: availableModels.some(am =>
        am.startsWith(m.family) && am.includes(m.id.split(':')[1])
      ),
      fitsVram: !vramMB || vramMB >= m.minVramMB,
    })),
    vramMB,
  };
}
