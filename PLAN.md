# CodeWeaver — Technical Design & Roadmap

> AI orchestration layer that turns plain-language prompts into real files.
> This file covers architecture, orchestration phases, deep implementation details, and roadmap.

**Quick start:** [README.md](./README.md)  
**Deep implementation spec:** [PLAN_DEEP.md](./PLAN_DEEP.md) ← quantity injection, all prompts, retry trees, probes

---

## Current State (summary)

| Area | Implementation |
|------|----------------|
| **Orchestrator** | `src/orchestrator.js` — deep retry loop with quantity injection |
| **Word** | V2: extract → blueprint → section codegen → deterministic assembly |
| **Excel / Chart / CSV** | Planned pipeline: new MD planner → per-step codegen → session execution |
| **Quantities** | `src/tasks/quantityResolver.js` → hard targets fed into every stage |
| **Skills** | `skills/*.md` + `src/skills/loader.js` → auto-injected by task/language/step |
| **Plan validation** | `src/validation/quantityValidator.js` → targeted corrections |
| **Step validation** | `src/validation/stepValidator.js` → syntax, signature, pattern, content-length |
| **Assembly** | `src/pipeline/assembler.js` — deterministic, no LLM |
| **Error classification** | `src/utils/errorClassifier.js` → typed fix instructions |
| **Per-job logging** | `src/utils/logger.js` → NDJSON log per job in `tests/output/` |
| **LLM** | Gemini, Groq, OpenRouter, NVIDIA + cross-provider fallback |
| **Local real run** | `npm test` (`tests/runPrompt.js` + `tests/prompt.js`, no Execify) |
| **API server** | `npm start` (Execify required for real execution) |

---

## Project Structure

```
codeweaver/
├── src/
│   ├── server.js
│   ├── orchestrator.js               ← full retry loop with quantity injection
│   ├── config.js
│   ├── pipeline/
│   │   ├── planParser.js             ← parses Markdown plan → { header, imports, steps[] }
│   │   └── assembler.js              ← deterministic: imports + functions + main()
│   ├── skills/
│   │   └── loader.js                 ← extractSkillSections(), pickSkillSection(), loadSkillForTask()
│   ├── llm/
│   │   ├── client.js                 ← provider chain + raceAndPickBest()
│   │   ├── prompts.js                ← ALL prompt templates (new pipeline + legacy)
│   │   ├── gemini.js
│   │   ├── groq.js
│   │   ├── openrouter.js
│   │   └── nvidia.js
│   ├── execify/
│   │   ├── client.js
│   │   ├── validator.js
│   │   └── probes/
│   │       ├── probe_docx.py         ← word count + paragraph count
│   │       ├── probe_xlsx.py         ← row count + column count
│   │       └── probe_chart.py        ← image dimensions
│   ├── validation/
│   │   ├── quantityValidator.js      ← checks plan word/row sums + fn dependency graph
│   │   ├── stepValidator.js          ← syntax, signature, pattern, content-length probes
│   │   └── assemblyValidator.js      ← all planned functions present and called
│   ├── errors/
│   │   └── (in utils/errorClassifier.js)
│   ├── content/
│   │   ├── extractor.js              ← Word V2: LLM JSON extraction
│   │   └── blueprint.js              ← Word V2: deterministic flattening
│   ├── startup/
│   │   └── envCheck.js               ← Python/Node package + LLM key checks on startup
│   ├── tasks/
│   │   ├── taskAnalyzer.js           ← analyzeTask() + quantities pre-computed
│   │   ├── quantityResolver.js       ← "10-page" → { total_words:2500, sections:8, … }
│   │   ├── taskParser.js             ← (legacy)
│   │   └── taskTypes.js
│   └── utils/
│       ├── logger.js                 ← console + per-job NDJSON file
│       ├── contractChecker.js
│       ├── errorClassifier.js        ← classifyError() + buildFixInstruction()
│       ├── jsonExtract.js
│       ├── llmParse.js
│       └── nodeAssembly.js
├── skills/
│   ├── index.json
│   ├── word-node.md                  ← + quantity_patterns section
│   ├── excel-node.md                 ← + quantity_patterns section
│   ├── excel-python.md               ← + quantity_patterns / bulk_data section
│   └── chart-python.md               ← + quantity_patterns section
├── tests/
│   ├── prompt.js                     ← test prompts
│   ├── runPrompt.js                  ← local runner
│   └── output/                       ← job log files written here
├── .env.example
├── README.md                         ← quick start, commands
├── PLAN.md                           ← this file
└── PLAN_DEEP.md                      ← payload map, all prompts, retry trees, probes
```

---

## What This Project Is

CodeWeaver sits on top of Execify. It is the brain. Execify is the muscle.

A user says: *"Make me an Excel report with regional sales, formulas, and a summary dashboard"*

CodeWeaver:
1. Understands the request (unified task analysis + **quantity resolution**)
2. Refines the prompt into a detailed spec (refiner LLM call)
3. Plans the code structure (**Markdown plan** with per-step word/row targets)
4. **Validates the plan** against quantity targets — targeted corrections if needed
5. Generates code in chunks with domain skills and **per-step probes** (syntax, signature, content-length)
6. Assembles deterministically and executes via Execify
7. Validates output against the original quantity targets
8. Re-runs failing steps with targeted expansion prompts
9. Delivers the file

---

## Architecture

```
User (Chat UI)
      ↓
  API Layer  (Express — CodeWeaver)
      ↓
  Orchestrator  (brain — manages the deep retry loop)
      ↓              ↓
  LLM Client        Execify Client
 (Gemini/Groq/      (local or remote)
  OpenRouter/NVIDIA)
      ↓              ↓
  Plan + Code   Execute + Verify
      ↓
  Quantity Validation → Output Probes
      ↓
  File → User
```

---

## Orchestration Phases

### Phase 0 — Task Analysis + Quantity Resolution

Single LLM call → task type, output filename, complexity, requirements, volume estimates.

Then `resolveQuantity()` converts the volume estimates to hard numeric targets:
- Word docs: `total_words`, `total_pages`, `sections`, `words_per_section`
- Excel/CSV: `total_rows`, `min_columns`, `column_hints`
- Charts: `data_points`

These targets are injected into every downstream LLM prompt. The LLM is never
allowed to guess quantities — they are always given explicitly.

### Phase 1 — Prompt Refinement

`buildRefinerPrompt()` turns the raw user message + quantity targets into a
detailed 100+ word specification paragraph. Validated against word count and
vague-language checks. Retried with targeted expansion if too short.

### Phase 2 — Planning

`buildNewPlannerPrompt()` produces a Markdown plan (not YAML) with:
- One `## step_N` per function
- Required `fn:`, `do:`, `words:` or `rows:` on every step

Plan is validated by `validatePlanQuantities()` against quantity targets.
**Targeted corrections** are sent for specific failures — the full plan is never
regenerated unless all correction attempts fail.

### Phase 3 — Code Generation

For each step:
1. `buildStepCodePrompt()` with only the **relevant skill section** (not the full file)
2. Code is generated and stripped of markdown fences
3. Four probes run: syntax check, signature check, pattern check, content-length estimate
4. If any probe fails, `buildStepFixPrompt()` sends a **targeted fix** — not a retry from scratch

### Phase 4 — Assembly

`assembleScript()` is deterministic — no LLM calls. Concatenates:
1. Imports block
2. Functions in plan order
3. `main()` with call chain derived from `fnParsed.inputs/outputs`

Validated by `validateAssembly()`.

### Phase 5 — Execution + Output Validation

Script runs on Execify (or locally via `npm test`). After execution:
- Python probes (`probe_docx.py`, `probe_xlsx.py`, `probe_chart.py`) measure actual output
- If output is too small, the **specific failing steps** are re-run with content expansion prompts
- Re-assembly and re-execution happen for the affected steps only

---

## Retry Decision Tree

```
refiner: too_short       → expansion prompt (max 2 retries)
refiner: vague_language  → specificity prompt (max 2 retries)

planner: missing_do      → targeted plan correction
planner: word_shortfall  → targeted plan correction
planner: row_missing     → targeted plan correction
                           (max 3 retries, then proceed with best plan)

step: SyntaxError        → buildStepFixPrompt() with error details
step: wrong_name         → rename instruction
step: content_too_short  → content expansion instruction
                           (max MAX_RETRIES per step, default 3)

assembly: missing fn     → re-codegen just that step

output: word_count low   → re-run 3 shortest content steps with expansion
output: row_count low    → re-run data-population step with row prompt
                           (max 2 output retry cycles)
```

---

## LLM Strategy

### Primary: Gemini Flash 2.5

Large context window, fast, follows structured output reliably.
Used for: task analysis, refinement, planning, all code generation.

### Cross-provider fallback

`LLM_FALLBACK_PROVIDERS=gemini,groq,openrouter` — tried in order after primary exhausts retries.

### Parallel racing (optional)

`LLM_PARALLEL_ENABLED=1` races models. **Planner and large content steps** are
raced (most critical calls). Fast calls (refiner, imports) are not raced — wastes rate limits.

When racing, picks the **longest valid response** that passes all probes. Not the fastest.

---

## Skills System

Skills are Markdown files in `skills/`. The loader now parses them into named
sections (by `##` heading) via `extractSkillSections()`.

`pickSkillSection()` returns only the **relevant section** for a given step:
- Imports step → `## imports`
- Setup step → `## setup`
- Word table step → `## tables`
- Excel data step → `## writing_data` / `## bulk_data`
- Chart step → `## chart_types`

This keeps each step prompt focused and under the 900-token input budget.

Required sections for every skill file:
- `## overview`
- `## imports`
- `## setup`
- `## quantity_patterns` ← new, injected when step has word/row target

---

## Per-Job Logging

`createJobLogger(jobId, outputDir)` writes a NDJSON log file to `tests/output/<jobId>.log`.
Every LLM input and output is logged. When output is wrong, open the log file and
trace exactly what the LLM received and returned at each step.

```
ts | stage         | data
---+---------------+-----------------------------------------------------------
   | raw_prompt    | { prompt: "..." }
   | quantities    | { total_words: 2500, sections: 8, ... }
   | refined       | { text: "...", words: 142 }
   | plan_attempt  | { attempt: 1, plan: "..." }
   | step_code     | { step: "step_2", code_lines: 45 }
   | exec_stdout   | { output: "SUCCESS: saved ..." }
   | probe_result  | { stats: { word_count: 2340, ... } }
   | done          | { output_path: "/workspace/report.docx" }
```

---

## Environment Variables

See `.env.example`. Key new variables:

| Variable | Purpose |
|----------|---------|
| `MAX_PLAN_RETRIES` | Max targeted plan correction attempts (default 3) |
| `MAX_OUTPUT_RETRIES` | Max output re-expansion cycles (default 2) |
| `LLM_PARALLEL_ENABLED` | Enable parallel model racing |
| `LLM_PARALLEL_MODELS` | Number of models to race |
| `CW_OUTPUT_DIR` | Output + log file directory |
| `CLEAN_PROBE=0` | Keep Python probe files for debugging |

---

## Build Phases

### Phase 1 — Foundation ✅ DONE
- [x] Express API, logger, Execify client
- [x] LLM client (Gemini, Groq, OpenRouter, NVIDIA)
- [x] Basic planner + codegen prompts + retry
- [x] POST /generate, GET /status, GET /stream, GET /download

### Phase 1.5 — Local runner ✅ DONE
- [x] `npm test` → `tests/runPrompt.js` + `tests/prompt.js`

### Phase 2 — Chunked generation ✅ DONE
- [x] Per-step execution + retry loop
- [x] Final step writes output file

### Phase 3 — Validation + Delivery ✅ DONE
- [x] File download endpoint
- [x] SSE streaming progress

### Phase 1.6 — Skills + LLM resilience ✅ DONE
- [x] `skills/` + loader, phase-aware injection
- [x] Cross-provider fallback

### Phase 4 — Deep Implementation ✅ DONE (this update)
- [x] `quantityResolver.js` — hard targets for every stage
- [x] `planParser.js` — Markdown plan → structured `{ header, imports, steps[] }`
- [x] `assembler.js` — deterministic assembly with call-chain inference
- [x] `quantityValidator.js` — targeted plan correction
- [x] `stepValidator.js` — syntax, signature, pattern, content-length probes
- [x] `assemblyValidator.js` — all functions present and called
- [x] `errorClassifier.js` — upgraded with `buildFixInstruction()`
- [x] Python probes: `probe_docx.py`, `probe_xlsx.py`, `probe_chart.py`
- [x] `envCheck.js` — startup environment check
- [x] `logger.js` — per-job NDJSON log files
- [x] `prompts.js` — all new pipeline prompts added (refiner, planner, correction, step, fix, expand)
- [x] `orchestrator.js` — full retry loop wired end-to-end
- [x] `loader.js` — `extractSkillSections()`, `pickSkillSection()`, `loadSkillForTask()`
- [x] `taskAnalyzer.js` — `quantities` pre-computed and attached to task spec
- [x] Skill files — `## quantity_patterns` section added to all four skills

### Phase 5 — Hardening (Next)
- [ ] Wire Python probes into output validation (call `probe_docx.py` etc. in validator.js)
- [ ] Persist jobs (replace in-memory Map; enable real /jobs listing)
- [ ] `LOCAL_EXEC` mode on server (Node/Python subprocess without Execify)
- [ ] Parallel LLM racing wired to planner + large content steps in orchestrator
- [ ] Expand test prompts in `tests/prompt.js` for all failure modes
- [ ] Rate-limit handling for Groq / NVIDIA on large prompts

---

## Design Decisions

**Why Markdown plans instead of YAML?**
YAML plans are great for machine parsing but weak LLMs often add prose inside
string fields, breaking the parser. Markdown with `##` headings and `key: value`
lines is more forgiving — the parser can extract steps even with extra whitespace
or explanatory text.

**Why targeted corrections instead of full plan regeneration?**
Regenerating the full plan discards the parts that were correct. A targeted
correction prompt says "fix only these 2 problems" — the LLM keeps the valid
steps and fixes only what's broken. This is faster and wastes fewer tokens.

**Why per-step skill section injection?**
Dumping the entire skill file into every step prompt wastes ~600-1200 tokens
on irrelevant content. A step that writes Excel data rows doesn't need the
Word heading patterns. `pickSkillSection()` sends only the relevant `##` section.

**Why quantity injection at every stage?**
LLMs forget quantitative constraints when prompts get long. Embedding the hard
numbers (`words:`, `rows:`) directly in every step prompt ensures the number
is always visible and not buried 800 tokens back.

---

## History

- 2026-05-13: Word V2 foundation in orchestrator
- 2026-05-24: Skills system; single prompt local runner; LLM cross-provider fallback; README/PLAN refresh
- 2026-05-29: Deep implementation — quantity resolver, plan parser, assembler, all validators, probes, per-job logger, upgraded error classifier, all new prompt templates, full retry loop in orchestrator, skill section extraction, quantity_patterns in skill files
