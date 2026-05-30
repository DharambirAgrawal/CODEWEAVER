// src/utils/logger.js
// Structured console logger + per-job file logger for debugging LLM inputs/outputs.

'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL || 'info'];

const colors = {
  debug: '\x1b[36m', // cyan
  info:  '\x1b[32m', // green
  warn:  '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  reset: '\x1b[0m',
};

function log(level, context, message, data = null) {
  if (LEVELS[level] < CURRENT_LEVEL) return;

  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const color = colors[level];
  const tag = `[${level.toUpperCase().padEnd(5)}]`;
  const ctx = context ? `[${context}]` : '';

  let line = `${color}${ts} ${tag}${colors.reset} ${ctx} ${message}`;
  if (data !== null) {
    const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    line += `\n${str}`;
  }
  console.log(line);
}

const logger = {
  debug: (ctx, msg, data) => log('debug', ctx, msg, data),
  info:  (ctx, msg, data) => log('info',  ctx, msg, data),
  warn:  (ctx, msg, data) => log('warn',  ctx, msg, data),
  error: (ctx, msg, data) => log('error', ctx, msg, data),

  step: (jobId, stepNum, totalSteps, name, status) => {
    const bar = `[${stepNum}/${totalSteps}]`;
    log('info', `job:${jobId.slice(0, 8)}`, `${bar} ${name} — ${status}`);
  },
};

// ── Per-job file logger ───────────────────────────────────────────────────────
// Creates a NDJSON log file in outputDir for each job so every LLM input/output
// can be reviewed without re-running the job.

function createJobLogger(jobId, outputDir) {
  const dir = outputDir || path.join(process.cwd(), 'tests', 'output');
  let logPath = null;

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, `${jobId}.log`);
  } catch {
    logPath = null;
  }

  function write(stage, data) {
    const entry = { ts: new Date().toISOString(), stage, ...data };
    if (logPath) {
      try { fs.appendFileSync(logPath, JSON.stringify(entry) + '\n'); } catch {}
    }
    if (process.env.LOG_LEVEL === 'debug') {
      log('debug', `job:${jobId.slice(0, 8)}`, `[${stage}]`, data);
    }
  }

  return {
    raw_prompt:    p      => write('raw_prompt',    { prompt: p }),
    quantities:    q      => write('quantities',    { quantities: q }),
    refined:       t      => write('refined',       { text: t, words: (t || '').split(' ').length }),
    plan_attempt:  (n, r) => write('plan_attempt',  { attempt: n, plan: r }),
    plan_errors:   errs   => write('plan_errors',   { errors: errs }),
    plan_accepted: p      => write('plan_accepted', { steps: p.steps?.length }),
    step_prompt:   (s, pr)=> write('step_prompt',   { step: s.title, prompt_chars: (pr || '').length }),
    step_code:     (s, c) => write('step_code',     { step: s.title, code_lines: (c || '').split('\n').length }),
    step_error:    (s, e) => write('step_error',    { step: s.title, error: e }),
    step_retry:    (s, n) => write('step_retry',    { step: s.title, attempt: n }),
    full_script:   sc     => write('full_script',   { lines: (sc || '').split('\n').length }),
    exec_stdout:   out    => write('exec_stdout',   { output: (out || '').slice(0, 500) }),
    exec_error:    err    => write('exec_error',    { error: (err || '').slice(0, 500) }),
    probe_result:  stats  => write('probe_result',  { stats }),
    output_retry:  (n, r) => write('output_retry',  { attempt: n, reason: r }),
    done:          p      => write('done',          { output_path: p }),
  };
}

logger.createJobLogger = createJobLogger;

module.exports = logger;
