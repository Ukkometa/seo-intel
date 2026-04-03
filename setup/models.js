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
  // ── Gemma 4 (Google, MoE) — new recommended default ──
  {
    id: 'gemma4:e2b',
    name: 'Gemma 4 E2B',
    family: 'gemma4',
    tier: 'budget',
    vram: '~5 GB',
    minVramMB: 4000,
    speed: '~1.5s/page',
    quality: 'good',
    description: 'Google Gemma 4 edge model. MoE (5.1B total, 2.3B active) — fast inference with good JSON output. Great for laptops.',
    recommended: false,
  },
  {
    id: 'gemma4:e4b',
    name: 'Gemma 4 E4B',
    family: 'gemma4',
    tier: 'balanced',
    vram: '~7 GB',
    minVramMB: 5500,
    speed: '~2s/page',
    quality: 'great',
    description: 'Default recommendation. MoE (8B total, 4.5B active) — excellent extraction quality at edge-model speed. Best quality/speed ratio.',
    recommended: true,
  },
  {
    id: 'gemma4:26b',
    name: 'Gemma 4 26B',
    family: 'gemma4',
    tier: 'quality',
    vram: '~13 GB',
    minVramMB: 11000,
    speed: '~4s/page',
    quality: 'excellent',
    description: 'MoE (25.2B total, 3.8B active) — frontier quality at efficient compute. Needs RTX 3090+ or M-series with 16GB+.',
    recommended: false,
  },
  {
    id: 'gemma4:31b',
    name: 'Gemma 4 31B (Dense)',
    family: 'gemma4',
    tier: 'power',
    vram: '~20 GB',
    minVramMB: 16000,
    speed: '~7s/page',
    quality: 'excellent',
    description: 'Dense 30.7B model — maximum extraction quality. Needs RTX 3090/4090 or M2 Pro+ with 24GB+.',
    recommended: false,
  },
  // ── Qwen 3.5 (Alibaba) ──
  {
    id: 'qwen3.5:4b',
    name: 'Qwen 3.5 4B',
    family: 'qwen3.5',
    tier: 'budget',
    vram: '~3 GB',
    minVramMB: 2500,
    speed: '~2s/page',
    quality: 'good',
    description: 'Reliable JSON extraction, decent keyword detection. Great for laptops and older GPUs.',
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
    description: 'Good entity detection and intent classification. Works on most modern GPUs.',
    recommended: false,
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
    description: 'Near-cloud quality extraction. Needs RTX 3090/4090 or M2 Ultra.',
    recommended: false,
  },
  // ── Alternative providers ──
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
  // ── Legacy / fallback models (already installed by many users) ──
  {
    id: 'qwen3:4b',
    name: 'Qwen 3 4B (legacy)',
    family: 'qwen3',
    tier: 'budget',
    vram: '~3 GB',
    minVramMB: 2500,
    speed: '~2s/page',
    quality: 'good',
    description: 'Previous generation. Gemma 4 or Qwen 3.5 recommended for new installs.',
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
    description: 'Previous generation. Gemma 4 or Qwen 3.5 recommended for new installs.',
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
//   Cloud models (Claude, GPT-5.4, Gemini) available via OpenClaw agent setup

export const ANALYSIS_MODELS = [
  {
    id: 'gemma4:26b',
    name: 'Gemma 4 26B (MoE)',
    family: 'gemma4',
    type: 'local',
    vram: '~13 GB',
    minVramMB: 11000,
    context: '128K tokens',
    costNote: 'Free (your GPU)',
    quality: 'great',
    recommended: true,
    description: 'Google Gemma 4 MoE — 25.2B total, 3.8B active. Fast analysis with frontier quality. Best local value.',
  },
  {
    id: 'gemma4:31b',
    name: 'Gemma 4 31B (Dense)',
    family: 'gemma4',
    type: 'local',
    vram: '~20 GB',
    minVramMB: 16000,
    context: '128K tokens',
    costNote: 'Free (your GPU)',
    quality: 'excellent',
    recommended: false,
    description: 'Google Gemma 4 dense model — maximum quality for local analysis. Needs RTX 3090+ or M2 Pro+ with 24GB.',
  },
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
    recommended: false,
    description: 'Strong reasoning with 27.8B params. Needs RTX 3090/4080+ or M-series with 24GB+.',
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
  // ── Cloud frontier models (require API key in .env) ──
  // ── Cloud frontier models (require API key in .env or via OpenClaw) ──
  {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    family: 'gemini',
    type: 'cloud',
    provider: 'gemini',
    envKey: 'GEMINI_API_KEY',
    context: '2M tokens',
    costNote: '~$0.01–0.05/analysis',
    quality: 'frontier',
    recommended: false,
    description: 'Google\'s latest frontier model. Massive 2M context handles the largest competitive datasets. Best value for cloud analysis.',
  },
  {
    id: 'claude-opus-4.6',
    name: 'Claude Opus 4.6',
    family: 'claude',
    type: 'cloud',
    provider: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    context: '1M tokens',
    costNote: '~$0.10–0.30/analysis',
    quality: 'frontier',
    recommended: false,
    description: 'Anthropic\'s most capable model. Deepest reasoning for competitive gap analysis, strategic positioning, and implementation briefs.',
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    family: 'gpt',
    type: 'cloud',
    provider: 'openai',
    envKey: 'OPENAI_API_KEY',
    context: '256K tokens',
    costNote: '~$0.05–0.15/analysis',
    quality: 'frontier',
    recommended: false,
    description: 'OpenAI\'s flagship frontier model. Strong analytical reasoning for competitive intelligence and strategic recommendations.',
  },
  {
    id: 'deepseek-r1',
    name: 'DeepSeek R1',
    family: 'deepseek',
    type: 'cloud',
    provider: 'deepseek',
    envKey: 'DEEPSEEK_API_KEY',
    context: '128K tokens',
    costNote: '~$0.005–0.02/analysis',
    quality: 'great',
    recommended: false,
    description: 'Reasoning-optimized model at a fraction of the cost. Excellent quality-to-price ratio for budget-conscious analysis.',
  },
];

// ── VRAM-Based Recommendations ──────────────────────────────────────────────

const VRAM_TIERS = [
  { maxMB: 2500,  extraction: null,           note: 'Not enough VRAM for local extraction. Use cloud or CPU mode (slow).' },
  { maxMB: 4500,  extraction: 'qwen3.5:4b',   note: 'Budget tier — Qwen 3.5 4B fits your GPU.' },
  { maxMB: 6000,  extraction: 'gemma4:e2b',   note: 'Edge tier — Gemma 4 E2B (MoE, fast).' },
  { maxMB: 12000, extraction: 'gemma4:e4b',   note: 'Balanced tier — Gemma 4 E4B recommended. MoE gives best quality/speed.' },
  { maxMB: 18000, extraction: 'gemma4:26b',   note: 'Quality tier — Gemma 4 26B MoE for frontier extraction.' },
  { maxMB: 48000, extraction: 'gemma4:31b',   note: 'Power tier — Gemma 4 31B Dense for maximum quality.' },
  { maxMB: Infinity, extraction: 'gemma4:31b', note: 'Power tier — Gemma 4 31B Dense recommended. Your GPU can handle anything.' },
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
    'gemma4:e4b', 'gemma4:26b', 'gemma4:e2b', 'gemma4:31b',
    'qwen3.5:9b', 'qwen3.5:27b', 'qwen3.5:4b', 'qwen3.5:35b',
    'qwen3:8b', 'qwen3:4b',
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
    'gemma4:26b', 'gemma4:31b', 'qwen3.5:27b', 'qwen3.5:35b', 'qwen3:14b', 'nemotron-3-super:120b',
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
  else if (vramMB >= 16000) recId = 'gemma4:31b';
  else if (vramMB >= 11000) recId = 'gemma4:26b';
  else if (vramMB >= 8000) recId = 'qwen3:14b';

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
      installed: m.type === 'cloud'
        ? !!(m.envKey && envKeys[m.envKey])
        : availableModels.some(am =>
            am.startsWith(m.family) && am.includes(m.id.split(':')[1])
          ),
      configured: m.type === 'cloud' ? !!(m.envKey && envKeys[m.envKey]) : undefined,
      fitsVram: m.type === 'cloud' ? true : (!vramMB || vramMB >= m.minVramMB),
    })),
    vramMB,
  };
}
