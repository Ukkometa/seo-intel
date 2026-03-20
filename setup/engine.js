/**
 * SEO Intel — Setup Engine
 *
 * Facade that re-exports all setup modules.
 * Used by both CLI wizard (config/setup-wizard.js) and web wizard (setup/web-routes.js).
 *
 * Usage:
 *   import { fullSystemCheck, getModelRecommendations, ... } from './setup/engine.js';
 */

// System detection
export {
  checkNodeVersion,
  checkNpm,
  checkOllamaLocal,
  checkOllamaRemote,
  checkOllamaAuto,
  checkPlaywright,
  checkNpmDeps,
  checkEnvFile,
  checkExistingConfigs,
  checkGscData,
  checkOpenClaw,
  detectOS,
  detectVRAM,
  fullSystemCheck,
  parseEnvFile,
} from './checks.js';

// Model recommendations
export {
  EXTRACTION_MODELS,
  ANALYSIS_MODELS,
  recommendExtractionModel,
  recommendAnalysisModel,
  getModelRecommendations,
} from './models.js';

// Auto-installers
export {
  installNpmDeps,
  installPlaywright,
  pullOllamaModel,
  createEnvFile,
} from './installers.js';

// Pipeline validation
export {
  testOllamaConnectivity,
  testApiKey,
  testCrawl,
  testExtraction,
  runFullValidation,
} from './validator.js';

// Config generation
export {
  slugify,
  domainFromUrl,
  buildProjectConfig,
  writeProjectConfig,
  writeEnvKey,
  updateEnvForSetup,
  validateConfig,
} from './config-builder.js';
