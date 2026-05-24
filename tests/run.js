// tests/run.js
// Run test scenarios to verify orchestration loop works without real Execify

require('dotenv').config();
process.env.MOCK_EXECIFY = 'true'; // Always use mock for tests

const { runJob, createJob, getJob } = require('../src/orchestrator');
const logger = require('../src/utils/logger');
const { setAvailableLibraries } = require('../src/llm/prompts');
const execify = require('../src/execify/client');
const { v4: uuidv4 } = require('uuid');

// Preload mock libraries
async function setup() {
  const modules = await execify.getInstalledModules();
  setAvailableLibraries({ python: modules.python, node: modules.node });
}

// Test scenarios
const SCENARIOS = [
  {
    name: 'Complex Word Document',
    message: 'Write a 5-page business report about quarterly sales performance with sections for executive summary, key metrics, regional breakdown, and recommendations',
  },

];

async function runScenario(scenario) {
  const jobId = uuidv4();
  logger.info('Test', `\n${'─'.repeat(60)}`);
  logger.info('Test', `Scenario: ${scenario.name}`);
  logger.info('Test', `Message: "${scenario.message}"`);
  logger.info('Test', `${'─'.repeat(60)}`);

  createJob(jobId, scenario.message);
  await runJob(jobId);

  const job = getJob(jobId);
  const passed = job.status === 'done';

  logger.info('Test', `Result: ${passed ? '✓ PASSED' : '✗ FAILED'}`);
  if (!passed) logger.error('Test', `Error: ${job.error}`);
  logger.info('Test', `Steps completed: ${job.currentStep}/${job.totalSteps}`);
  logger.info('Test', `Log:\n  ${job.log.join('\n  ')}`);

  return { scenario: scenario.name, passed, error: job.error };
}

async function main() {
  logger.info('Test', '🧪 CodeWeaver Test Suite');
  logger.info('Test', `Mock Execify: ${process.env.MOCK_EXECIFY}`);
  logger.info('Test', `LLM Provider: ${process.env.LLM_PROVIDER || 'gemini'}`);

  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY && !process.env.OPENROUTER_API_KEY) {
    logger.error('Test', 'No LLM API key found. Set GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY in .env');
    process.exit(1);
  }

  await setup();

  const results = [];
  for (const scenario of SCENARIOS) {
    try {
      const result = await runScenario(scenario);
      results.push(result);
    } catch (err) {
      logger.error('Test', `Scenario "${scenario.name}" threw unhandled error`, err.message);
      results.push({ scenario: scenario.name, passed: false, error: err.message });
    }
  }

  logger.info('Test', `\n${'═'.repeat(60)}`);
  logger.info('Test', 'TEST SUMMARY');
  logger.info('Test', '═'.repeat(60));
  const passed = results.filter(r => r.passed).length;
  results.forEach(r => {
    logger.info('Test', `${r.passed ? '✓' : '✗'} ${r.scenario}${r.error ? ` — ${r.error}` : ''}`);
  });
  logger.info('Test', `\n${passed}/${results.length} scenarios passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(err => {
  logger.error('Test', 'Test suite crashed', err.message);
  process.exit(1);
});
