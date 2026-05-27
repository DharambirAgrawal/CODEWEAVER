# CodeWeaver — AI Orchestration Layer for Execify

> AI-powered file generation for agents and chat UIs. User asks in plain language → plan → chunked code → execute → validate → deliver file.

**Start here:** [README.md](./README.md) (quick start, commands, testing).  
**This file:** technical design, phases, and roadmap.

---

## Current state (summary)

| Area | Implementation |
|------|----------------|
| **Purpose** | Agent backend for generating files (not an IDE) |
| **Orchestrator** | `src/orchestrator.js` — single pipeline controller |
| **Word** | V2: extract → blueprint → section codegen → deterministic assembly |
| **Excel / others** | Planned pipeline: planner → per-step codegen → session execution |
| **Skills** | `skills/*.md` + `src/skills/loader.js` → auto-injected by task/language |
| **LLM** | Gemini, Groq, OpenRouter; `LLM_FALLBACK_PROVIDERS` + `LLM_RETRY_ATTEMPTS` |
| **Local real run** | `npm test` (single prompt file, no Execify) |
| **API server** | `npm start` (Execify required for real execution) |

---

## What This Project Is

CodeWeaver sits on top of Execify. It is the brain. Execify is the muscle.

A user says: *"Make me an Excel report with regional sales, formulas, and a summary dashboard"*

CodeWeaver:
1. Refines vague requests using the skill catalog (`promptRefiner.js`)
2. Understands the request (task parse + optional skill context)
3. Plans the code structure (or Word V2 content/blueprint)
4. Generates code in chunks with domain skills in prompts
5. Sends each chunk to Execify to run and verify (or runs locally in test harnesses)
6. Assembles the final file (deterministic for Word V2 + local test finals)
7. Delivers it to the user

The user never sees code. They just get their file.

---

## Architecture Overview

```
User (Chat UI)
      ↓
  API Layer  (Express — CodeWeaver)
      ↓
  Orchestrator  (the brain — manages the full loop)
      ↓            ↓
  LLM Client        Execify Client
 (Gemini/Groq/      (local or remote)
  OpenRouter)
      ↓            ↓
  Plan + Code   Execute + Verify
      ↓
  File → User
```

---

## Project Structure

```
codeweaver/
├── src/
│   ├── server.js
│   ├── orchestrator.js
│   ├── skills/loader.js       # Skill registry + prompt injection
│   ├── llm/                   # client, gemini, groq, openrouter, prompts.js
│   ├── execify/               # client, validator
│   ├── content/               # Word V2: extractor.js, blueprint.js
│   ├── tasks/                 # taskParser.js, taskTypes.js
│   └── utils/                 # logger, jsonExtract, contractChecker, errorClassifier
├── skills/
│   ├── index.json
│   ├── word-node.md
│   └── excel-node.md
├── tests/
│   ├── prompt.py              # Single prompt input
│   └── runPrompt.js           # Local runner
├── README.md
├── PLAN.md
└── .env.example
```

---

## Environment Configuration

```env
# Server
PORT=4000

# LLM Provider (gemini | groq | openrouter | nvidia)
LLM_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_key_here
GROQ_API_KEY=your_groq_key_here
OPENROUTER_API_KEY=your_openrouter_key_here
NVIDIA_API_KEY=your_nvidia_key_here
OPENROUTER_MODEL=openrouter/free
# Optional: comma-separated fallback list (overrides OPENROUTER_MODEL)
# OPENROUTER_MODELS=model-a,model-b,model-c
# Optional: comma-separated NVIDIA model list
# NVIDIA_MODELS=model-a,model-b,model-c
# Optional OpenRouter app metadata (sent as HTTP headers)
# OPENROUTER_APP_URL=https://your-app.example
# OPENROUTER_REFERER=https://your-app.example
# OPENROUTER_APP_NAME=CodeWeaver

# Execify
EXECIFY_BASE_URL=http://localhost:3000
EXECIFY_API_KEY=key-abc123

# Orchestrator Limits
MAX_RETRIES=5
# MAX_CHUNKS=10          # reserved (not wired yet)
# CHUNK_TIMEOUT_MS=30000 # reserved (not wired yet)

# Cross-provider fallback when primary hits 429/503/etc.
# LLM_FALLBACK_PROVIDERS=groq,openrouter
# LLM_RETRY_ATTEMPTS=3

# Skills (skills/index.json). SKILLS_ENABLED=0 to disable.
# SKILL_MAX_CHARS=12000


# --- Local single-prompt runner (tests/runPrompt.js) ---
# CW_PROMPT_FILE=tests/prompt.py
# CW_OUTPUT_DIR=tests/output
# CW_CODE_GEN_MAX_TOKENS=6000
# CW_PYTHON=/path/to/python
```

**Important:** For **real** files locally, use `npm test` (single prompt runner).

---

## The Orchestration Loop (Core Logic)

This is the heart of the system. Every user request goes through this exact flow.

### Phase 0 — Prompt refinement

Before JSON task parse or planning, a lightweight LLM call receives:

- The raw user message (may be short or ambiguous)
- A catalog of registered skills (`id` + `description` + task types) from `skills/index.json`
- Supported output types from `taskTypes.js`

It returns structured JSON:

```json
{
  "refinedPrompt": "Detailed, actionable specification for planners and codegen",
  "taskType": "excel",
  "complexity": "medium",
  "outputFileName": "sales_report.xlsx",
  "requirements": ["1000 rows", "group by region", "summary sheet"]
}
```

Downstream steps use `refinedPrompt` as the working spec; `rawMessage` is preserved for traceability. Disable with `PROMPT_REFINE_ENABLED=0`.

Implementation: `src/tasks/promptRefiner.js`, wired in `orchestrator.js` and `tests/runPrompt.js`.

### Phase 1 — Task Parsing

The refined prompt is parsed into a structured task object:

```json
{
  "type": "excel",
  "description": "Sales report with 1000 rows grouped by region",
  "outputFile": "sales_report.xlsx",
  "complexity": "high",
  "estimatedChunks": 4,
  "requirements": [
    "1000 rows of data",
    "grouped by region",
    "totals per region",
    "formatted headers"
  ]
}
```

LLM does this parsing. It is cheap — just a classification call with a small prompt.

### Phase 2 — Planning

LLM receives the task and produces a structured plan. **No code yet.** Just a breakdown:

```json
{
  "plan": [
    {
      "step": 1,
      "name": "setup",
      "description": "Import libraries, define constants, create workbook",
      "dependsOn": []
    },
    {
      "step": 2,
      "name": "generate_data",
      "description": "Generate 1000 rows of sales data with regions",
      "dependsOn": [1]
    },
    {
      "step": 3,
      "name": "group_and_total",
      "description": "Group data by region, calculate totals",
      "dependsOn": [2]
    },
    {
      "step": 4,
      "name": "format_and_save",
      "description": "Apply formatting, headers, save to /workspace/output.xlsx",
      "dependsOn": [3]
    }
  ],
  "language": "python",
  "libraries": ["openpyxl", "pandas"]
}
```

### Phase 3 — Chunked Code Generation + Execution

For each step in the plan:

1. LLM generates code for THAT STEP ONLY as a function
2. CodeWeaver sends it to Execify via the same session
3. Execify runs it
4. CodeWeaver validates the result (not just "did it run" — see Validation below)
5. If pass → move to next step, carry forward verified function
6. If fail and retryable → send error back to LLM with context, retry (up to MAX_RETRIES)
7. If non-retryable error or MAX_RETRIES exhausted → abort with clear error to user

Context passed to LLM on each turn:
- Original user request (always)
- Full plan (always)
- All previously verified functions (always — this is the assembly context)
- Current step description (current)
- Last error or output (current)

### Phase 4 — Assembly

| Path | How assembly works |
|------|-------------------|
| **Word (V2)** | Orchestrator builds the final script deterministically (`buildAssemblyScript`) — no LLM for assembly |
| **Excel / PDF / CSV / etc.** | LLM writes final step that saves to `/workspace/<outputFile>`; sent to Execify |
| **Local runner (`npm test`)** | Generates a single Python script and executes locally; writes to `tests/output/` |

After assembly, the final script runs on Execify (or locally in test harnesses). The output file is produced.

### Phase 5 — Validation

Not just "did it run". Real checks:

| Task Type | Validation Checks |
|-----------|------------------|
| Excel     | File exists, size > 1KB, optional row count check if stdout includes a "N rows" hint |
| Word/DOCX | File exists, size > 2KB |
| PDF       | File exists, size > 1KB |
| CSV       | File exists, size > 100 bytes, optional row count check if stdout includes a "N rows" hint |
| Chart/Image | File exists, size > 5KB |

For intermediate steps, validation only checks that execution succeeded; file checks happen on the final step. Row-count checks (when present in stdout) allow a 10% tolerance.

### Phase 6 — Delivery

Output file is returned to user as a downloadable response. Base64 from Execify is decoded and served.

---

## LLM Strategy

### Primary: Gemini Flash 2.5 (gemini-2.5-flash)

- Large context window — can hold the full plan + all verified functions without truncation
- Fast and free tier is generous
- Follows structured JSON instructions reliably
- Used for: task parsing, planning, all code generation turns

### Cross-provider fallback (`src/llm/client.js`)

- `LLM_FALLBACK_PROVIDERS=gemini,groq,openrouter` — tried in order after primary exhausts retries
- `LLM_RETRY_ATTEMPTS` (default 3) per provider before switching
- Retries on 429, 503, timeouts, and similar transient errors

### Alternative: Groq (Llama)

- Selected via `LLM_PROVIDER=groq`
- Model fallback chain inside Groq client; free tier often 429/413 on large doc/excel test prompts

### OpenRouter

- Selected via `LLM_PROVIDER=openrouter`. Same OpenAI-style chat completions; configure models with `OPENROUTER_MODEL` or `OPENROUTER_MODELS` (comma-separated fallback on transient HTTP errors).
- **Structured planning and task JSON:** OpenRouter and Groq send `response_format: { type: "json_object" }` when `jsonObject: true` is passed from callers. If a model returns HTTP 400/422 for unsupported structured output, the client automatically retries that model once without `json_object`. Gemini uses `generationConfig.responseMimeType: "application/json"` for the same contract.
- JSON mode fixes **syntax-level** failures (markdown fences, trailing commentary, half-open strings). It does not guarantee a *good* plan; validation and fallbacks still matter.

### Structured outputs and parsing (planning is not chain-of-thought)

Several steps require machine-readable JSON: task parsing (`taskParser.js`) and planning (`orchestrator.js`, local runner). The failure you get when a model “talks inside JSON” is usually **architecture**, not model quality: the same completion was being used for both a strict data contract and loose natural language.

**How we handle it in production:**

1. **Provider JSON mode** where supported, so the completion is constrained to a single JSON value (see OpenRouter above). This removes markdown wrappers and most unterminated-string errors.

2. **Brace-balanced extraction** in `src/utils/jsonExtract.js`. A greedy `/{[\s\S]*}/` regex is unsafe: it ignores string boundaries, so a `}` inside a string can truncate early, or multiple objects can glue together. The extractor finds the first `{`, then tracks nesting depth while respecting double-quoted strings and escapes, and parses only that span with `JSON.parse`.

3. **Semantic validation after parse.** For the doc test, a plan must start with a setup step and end with an assemble step, and every `functionName` must be a valid JavaScript identifier. Invalid plans are retried with an explicit “no prose inside string fields” reminder.

4. **Plan fallback.** If planning JSON is invalid, the system falls back to a simple two-step plan so code generation can proceed.

**Chain-of-thought vs this design:** If you want visible reasoning, use a separate user/assistant turn, a dedicated preface the parser strips, or a model feature designed for reasoning tokens. Do not ask the model to “think step by step” inside JSON field values; weak models especially will echo instructions or drift into prose mid-string, which breaks `JSON.parse` or passes garbage into downstream steps.

### Context Management

Each LLM call gets a carefully assembled context object. We never dump everything blindly.

```
System prompt (fixed)
  + Available libraries from Execify /installed-modules (fetched once on startup)
  + Task description
  + Plan
  + Verified functions so far (full code for the last 2 steps; older steps reduced to one-line references)
  + Current step
  + Last error (if retry)
```

For long jobs, we keep full bodies of the last 2 steps and replace older ones with short references. The plan always stays intact as the anchor.

### Prompts Design

Prompts live in `src/llm/prompts.js` and are augmented by **`buildSkillPromptBlock()`** from `src/skills/loader.js`:

- **Prompt refine** — `promptRefiner.js` (+ skill catalog from `getSkillCatalog()`)
- **Task parse** — `taskParser.js`
- **Planner** — `buildPlannerPrompt` (+ skill summary for task type)
- **Codegen** — `buildCodeGenPrompt`, `buildSectionPrompt` (Word V2)
- **Retry** — `buildRetryPrompt`
- **Validation fix** — `buildValidationFixPrompt` (wired in orchestrator for `validation_error` retries)

Skills: `skills/index.json` matches `task.type`, `language`, `library`, and phase (`plan`, `codegen`, `section`, `retry`, etc.).

---

## Domain skills

| Skill | Match | Used by |
|-------|-------|---------|
| `word-node.md` | word + node + docx | Orchestrator (Node docx) |
| `excel-node.md` | excel + node + xlsx | Orchestrator (Node xlsx) |

Skills document APIs, `/workspace` paths (Execify), formula patterns, and common mistakes.

---

## Local single-prompt runner (real files, no Execify)

Use `tests/prompt.py` as the single prompt input. Run:

```bash
npm test
```

The runner detects the task type from the prompt, plans the steps, generates code, and executes locally using Python. Output files are written to `tests/output/`.

---

## Handling Long Generation (The Real Problem)

This is why chunking matters. A 10-page Word doc or Excel with 1000 rows cannot be generated in one LLM call reliably.

**What goes wrong with one-shot generation:**
- Token limit cuts code off mid-function
- LLM loses track of structure in long generations
- One bug anywhere breaks everything
- No way to recover without starting over

**What chunking solves:**
- Each function is small (50-150 lines max)
- If one step fails, only that step retries
- Already-verified steps are locked in
- LLM has focused context for each step, not a wall of code

**The session is the key:**
Execify sessions persist the workspace between calls. So step 1 writes helper functions, step 2 can call them, step 3 builds on step 2's output. The container is stateful across our chunked calls. This is exactly what `POST /session/create` was built for.

---

## Execify (production)

For production runs, configure `EXECIFY_BASE_URL` and `EXECIFY_API_KEY` and run through the API server (`npm start`).

---

## API Endpoints (CodeWeaver)

### POST /generate
Main endpoint. Takes user message, returns job ID.

Request:
```json
{
  "message": "Make me an Excel report with 1000 rows of sales data by region",
  "userId": "user123"
}
```

Response:
```json
{
  "jobId": "job_abc123",
  "status": "started",
  "message": "Working on your Excel report..."
}
```

### GET /status/:jobId
Poll for job status and progress.

Response:
```json
{
  "jobId": "job_abc123",
  "status": "running",
  "currentStep": 2,
  "totalSteps": 4,
  "stepName": "generate_data",
  "message": "Generating 1000 rows of sales data..."
}
```

### GET /download/:jobId
When status is "done", download the file.

Response: File stream with correct Content-Type and Content-Disposition headers.

### GET /stream/:jobId (SSE)
Real-time progress stream. Emits events as steps complete.

```
data: {"status":"running","currentStep":1,"totalSteps":4,"stepName":"setup","message":"..."}

data: {"status":"running","currentStep":2,"totalSteps":4,"stepName":"generate_data","message":"..."}

event: done
data: {"jobId":"job_abc123","downloadUrl":"/download/job_abc123"}
```

---

## Supported Task Types

| Type | Production (Execify) | Local real test | Skill |
|------|----------------------|-----------------|-------|
| Excel `.xlsx` | Python `openpyxl` | Python `openpyxl` (local runner) | `excel-python.md` or `excel-node.md` |
| Word `.docx` | Python `python-docx` | Node `docx` (local runner) | `word-node.md` |
| Chart | matplotlib, seaborn | Python `matplotlib`/`seaborn` (local runner) | `chart-python.md` |
| PDF | reportlab, fpdf2 | — | — |
| CSV | csv (stdlib) | — | — |
| Text | stdlib | — | — |

Runtime language/library chosen in `taskTypes.js` via `resolveRuntimeTask()`: local Word → Node/`docx`; local Excel/chart → Python; production Word → Python/`python-docx` on Execify.

Extend by adding task type + optional skill in `skills/index.json`.

---

## Error Handling Strategy

| Error Type | Action |
|-----------|--------|
| `execution_error` (retryable) | Retry up to MAX_RETRIES with error context |
| `syntax_error` (retryable=false) | Stop early for the step and fail the job |
| `validation_error` | Retry the step, passing the validation message as error context |
| LLM error | `llmComplete`: retries per provider, then `LLM_FALLBACK_PROVIDERS` |
| Plan parse error | Fallback to a simple 2-step plan |

---

## Build Phases

### Phase 1 — Foundation ✅ DONE
- [x] Project setup, .env, logger
- [x] Execify HTTP client
- [x] LLM client (Gemini + Groq + OpenRouter)
- [x] Basic prompts (task parser, planner, code gen, retry, validation fix)
- [x] Orchestrator with full chunked loop + retry
- [x] POST /generate, GET /status, GET /stream, GET /download endpoints
- [x] Output validator (file size, row count, type checks)

### Phase 1.5 — Local single-prompt runner ✅ DONE

- Single input file at `tests/prompt.py`
- `npm test` plans, generates, and executes locally via Python
- Outputs written to `tests/output/`

### Phase 2 — Chunked Generation
- [x] Chunked code generation with session
- [x] Per-step execution and retry loop
- [x] Context assembly and trimming
- [x] Final step writes the output file

### Phase 3 — Validation + Delivery
- [x] Baseline output validators per task type
- [x] File download endpoint
- [x] SSE streaming progress

### Phase 1.6 — Skills + LLM resilience ✅ DONE
- [x] `skills/` + `src/skills/loader.js`
- [x] `word-node.md`, `excel-node.md`, `excel-python.md`, `chart-python.md`, `skills/index.json`
- [x] Cross-provider `LLM_FALLBACK_PROVIDERS` + `LLM_RETRY_ATTEMPTS`
- [x] `buildValidationFixPrompt` wired in orchestrator

### Phase 4 — Hardening (Next)
- [ ] Persist jobs (replace in-memory Map; enable real /jobs listing)
- [ ] Local Excel runner without re-clearing output on partial failure (resume)
- [ ] Expand validations (Excel formula verification, CSV headers)
- [ ] Add richer sample prompts for the single-prompt runner
- [ ] Simple chat UI or agent SDK integration (optional)
- [ ] `LOCAL_EXEC` mode on server (Node/Python subprocess without Execify)

---

## Key Design Decisions

**Why Node.js for CodeWeaver?**
Execify is Node. Same ecosystem. No context switching. Shared understanding of the codebase.

**Why Gemini Flash over GPT?**
Free tier. Large context window. Fast. Reliable JSON output. For a project built around multi-turn loops with large contexts, this matters more than raw capability.

**Why sessions over stateless calls?**
Files persist in `/workspace` across steps. Step 3 can read what step 2 wrote. Without sessions, each step starts fresh and cannot build incrementally. Sessions are the foundation of chunked generation.

**Why validate output not just execution?**
A script that runs without error but produces a 1KB Excel for 1000 rows clearly failed silently. Validation catches this. The LLM gets the validation result as feedback and can fix the logic, not just the syntax.

**Why keep Execify separate?**
Clean separation of concerns. Execify does one thing — safe execution. CodeWeaver does one thing — AI orchestration. Either can be upgraded, replaced, or scaled independently.

---

## Word V2 pipeline ✅ IMPLEMENTED

Implemented in orchestrator for `task.type === 'word'`:

1. Content extraction (`content/extractor.js`)
2. Blueprint (`content/blueprint.js`)
3. Section-by-section rendering (`buildSectionPrompt` + skills)
4. Deterministic assembly (`buildAssemblyScript` in orchestrator)
5. Error classification (`errorClassifier.js`) + contract checks (`contractChecker.js`)
6. Structural DOCX validation (`validator.js`)
7. Production: `python-docx`

---

## How to run and test (today)

| What you want | Command | Notes |
|---------------|---------|--------|
| Single prompt local runner | `npm test` | Reads `tests/prompt.py`, writes to `tests/output/` |
| HTTP API | `npm start` | Execify required for real execution |

Recommended: `LLM_PROVIDER=gemini` for local runs (Groq free tier often 429/413 on large prompts).

Full tables and env vars: [README.md](./README.md).

---

## History (Short)

- 2026-05-13: Word V2 foundation in orchestrator.
- 2026-05-24: Skills system; single prompt local runner; LLM cross-provider fallback; README/PLAN refresh.