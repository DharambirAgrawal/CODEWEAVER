// src/server.js
// CodeWeaver API server

require('dotenv').config();

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { runJob, createJob, getJob, subscribeToJob, unsubscribeFromJob } = require('./orchestrator');
const execify = require('./execify/client');
const { setAvailableLibraries } = require('./llm/prompts');
const logger = require('./utils/logger');

const app = express();
app.use(express.json());

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function startup() {
  logger.info('Server', `Starting CodeWeaver...`);
  logger.info('Server', `Execify mode: ${execify.isMock ? 'MOCK (no real execution)' : 'LIVE'}`);
  logger.info('Server', `LLM provider: ${process.env.LLM_PROVIDER || 'gemini'}`);

  // Load installed libraries from Execify once — used in all LLM prompts
  try {
    const modules = await execify.getInstalledModules();
    const libs = {
      python: modules.python || [],
      node: modules.node || [],
    };
    setAvailableLibraries(libs);
    logger.info('Server', `Loaded ${libs.python.length} Python + ${libs.node.length} Node libraries from Execify`);
  } catch (err) {
    logger.warn('Server', 'Could not load installed modules, using defaults', err.message);
  }

  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    logger.info('Server', `CodeWeaver listening on http://localhost:${port}`);
    logger.info('Server', `Ready to generate files!`);
  });
}

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const execifyHealth = await execify.health().catch(e => ({ status: 'error', error: e.message }));
  res.json({
    status: 'ok',
    codeweaver: 'running',
    execify: execifyHealth,
    mockMode: execify.isMock,
    llmProvider: process.env.LLM_PROVIDER || 'gemini',
  });
});

// ─── GENERATE — start a file generation job ───────────────────────────────────
app.post('/generate', async (req, res) => {
  const { message, userId } = req.body;

  if (!message || message.trim().length < 5) {
    return res.status(400).json({ error: 'message is required and must be at least 5 characters' });
  }

  const jobId = uuidv4();
  const job = createJob(jobId, message.trim());

  // Fire and forget — job runs in background
  runJob(jobId).catch(err => {
    logger.error('Server', `Unhandled job error for ${jobId}`, err.message);
  });

  res.status(202).json({
    jobId,
    status: 'started',
    message: 'Working on your file. Poll /status/:jobId for progress or connect to /stream/:jobId for live updates.',
    pollUrl: `/status/${jobId}`,
    streamUrl: `/stream/${jobId}`,
    downloadUrl: `/download/${jobId}`,
  });
});

// ─── STATUS — poll for job progress ───────────────────────────────────────────
app.get('/status/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({
    jobId: job.id,
    status: job.status,
    currentStep: job.currentStep,
    totalSteps: job.totalSteps,
    stepName: job.stepName,
    task: job.task ? {
      type: job.task.type,
      label: job.task.label,
      complexity: job.task.complexity,
      outputFile: job.task.outputFile,
    } : null,
    log: job.log,
    error: job.error || null,
    ready: job.status === 'done',
    downloadUrl: job.status === 'done' ? `/download/${job.id}` : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
});

// ─── STREAM — SSE live progress ───────────────────────────────────────────────
app.get('/stream/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = getJob(jobId);

  if (!job) return res.status(404).json({ error: 'Job not found' });

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current state immediately
  res.write(`data: ${JSON.stringify({ status: job.status, log: job.log })}\n\n`);

  // If already done/failed, close immediately
  if (job.status === 'done' || job.status === 'failed') {
    res.write(`event: ${job.status}\ndata: ${JSON.stringify({ jobId, status: job.status, error: job.error })}\n\n`);
    return res.end();
  }

  // Subscribe to updates
  const sendUpdate = (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.status === 'done') {
        res.write(`event: done\ndata: ${JSON.stringify({ jobId, downloadUrl: `/download/${jobId}` })}\n\n`);
        cleanup();
        res.end();
      } else if (event.status === 'failed') {
        res.write(`event: failed\ndata: ${JSON.stringify({ jobId, error: event.error })}\n\n`);
        cleanup();
        res.end();
      }
    } catch {}
  };

  const cleanup = () => unsubscribeFromJob(jobId, sendUpdate);
  subscribeToJob(jobId, sendUpdate);
  req.on('close', cleanup);
});

// ─── DOWNLOAD — serve the generated file ──────────────────────────────────────
app.get('/download/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(409).json({ error: `Job is not done yet (status: ${job.status})` });
  if (!job.outputData) return res.status(404).json({ error: 'No output file available' });

  const buffer = Buffer.from(job.outputData, 'base64');
  const filename = job.outputFile || 'output';

  res.setHeader('Content-Type', job.outputMime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
});

// ─── LIST JOBS (dev only) ─────────────────────────────────────────────────────
app.get('/jobs', (req, res) => {
  // Only in mock mode — for dev visibility
  if (!execify.isMock) return res.status(403).json({ error: 'Not available in production mode' });
  res.json({ jobs: 'job listing requires persistence layer — coming in Phase 4' });
});

// ─── BOOT ─────────────────────────────────────────────────────────────────────
startup().catch(err => {
  logger.error('Server', 'Startup failed', err.message);
  process.exit(1);
});
