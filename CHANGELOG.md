# Xkaliber Agent Changelog

## [41.9.0] - 2026-06-04

### Fixed
- **Build could spin for many turns doing nothing, then die with `[BLOCKED step null]`.** `submit_plan` was offered (and handled) during the execution phase. A small model that re-emitted `submit_plan` mid-build hit `plan-create`, which made a fresh `awaiting_approval` plan with `currentStepId = null` — wiping the live plan and stranding the loop until the no-progress ceiling killed it. Now `submit_plan` is excluded from the execution tool set, and its handler refuses to recreate a plan that is already approved/executing (covering the text tool-call fallback), steering the model to work the current step or use `add_steps`. Regression-tested in `tests/submitPlanGuard.test.js`.

### Coding-Capability Tier 2

Coding-capability **Tier 2** from the audit — the structural items that most raise multi-step build quality. New tests in `tests/codingTier2.test.js`; suite now 67. Verified live in the running app (new tools registered; `fetch_url` strips HTML and is netGuard-blocked for internal hosts).

### Added — plan can now adapt mid-build
- **`add_steps` tool.** The agent appends new steps to the running plan when it discovers unplanned work (a missing config, migration, refactor); they appear in the plan panel and execute after the current ones — no re-approval (`planStore.addSteps`, IPC `plan-add-steps`).
- **Retry-then-skip on `mark_step_blocked`.** A blocked step first gets one chance to try a different approach to the *same* step instead of stranding its dependents; only then does it skip. Harness auto-blocks (stall/loop/edit-fail) still skip immediately.

### Added — new capabilities (toward production-agent parity)
- **`fetch_url` tool.** Fetch a docs/API page and get its readable text (HTML stripped, ~8 KB cap), routed through `lib/netGuard.js` (metadata/link-local/ULA blocked). Lets the model read real documentation instead of guessing from a search snippet. Available in planning and execution.
- **Background-process control.** `read_process_log` now reports `{ running, exitCode }`; new `list_processes` and `stop_process` tools; foreground `run_shell_command` gets a 5-min timeout so a forgotten long-runner fails fast instead of hanging the turn. Enables start-server → poll → curl → kill.

### Changed — verification & robustness
- **Per-step syntax gate.** Every step must now pass a fast per-file syntax check before `mark_step_done` (the full test/lint suite still runs only on the final step), so broken code is caught immediately instead of piling up to the end.
- **Unified-diff applier fails loudly.** A patch whose context/delete line doesn't match now returns a clear error and the model re-reads — previously it consumed to end-of-file, silently corrupting the file while reporting success.
- **Reading isn't a stall.** Read-only investigation (read/grep/glob/list/repo-map/fetch) no longer counts toward the "no progress" ceiling, so the agent can study several files before editing without getting its step killed.
- **Read files stay in context.** A file the model `read_file`s during a step is auto-added to that step's context (capped), so the dependency it just read doesn't fall out next turn.
- **Embeddings fallback.** When Ollama is unreachable, vector memory falls back to the configured LLM's OpenAI-compatible `/v1/embeddings`, so LM-Studio-only setups get working memory instead of silent failure.

### UI Freeze & Tier 1 Updates

Fixed the **UI freeze while the agent is working** — root-caused to two synchronous hot paths (regression tests in `tests/perfFreeze.test.js`; suite now 59). Measured in the running app: streaming a 111 KB buffer went from **~3,700 ms of blocked UI thread to ~0 ms**.

### Fixed
- **Per-token re-render froze the renderer (primary cause).** `streamCompletion` calls `onDelta(fullContent)` on every streamed token, and the agent UI re-ran `markedParse` (full markdown + `highlight.js`) over the entire growing buffer and rebuilt the DOM each time — O(n²), worst with **small models**, which stream tool calls as plain text so a large `write_file` body balloons the buffer. Streaming now uses a **coalescing throttle** (`lib/renderThrottle.js`, ~10 fps) with a **cheap plain-text preview** (capped tail, no markdown/highlight per token); the full formatted result still renders once when the turn ends. The UI thread stays responsive throughout.
- **Repo map rebuilt synchronously every turn (secondary cause).** `buildRepoMap` did a synchronous whole-tree walk + 25 file reads in the main process on every execution turn, briefly freezing the whole app each turn. It's now **cached** (keyed by project root + boost terms, 10 s TTL) and **invalidated on file writes/edits/deletes**, so within a step the walk runs once instead of every turn.

Coding-capability **Tier 1** from the audit (`docs/CODING_CAPABILITY_AUDIT.md`) — the changes that most move Build Mode toward production-grade reliability on a small local model. New regression tests in `tests/codingTier1.test.js`; the suite is now 54.

### Fixed — the model no longer edits blind (`contextBuilder.js`)
- **Line numbers on every injected file** so the model can locate code precisely and build accurate `edit_file` find-blocks (the prompt tells it not to copy the `N⇥` prefix into edits).
- **No more silent middle-of-file truncation.** Oversized files show a contiguous numbered head plus an explicit `[lines X–Y omitted — use read_file…]` notice, instead of head+tail (which dropped the edited region while looking complete).
- **Honest token budget.** Estimate tightened from 3.5→2.5 chars/token (code tokenizes denser), exact-string accounting (was undercounting), and a hard fit-check that trims from the end until the prompt fits `num_ctx` but **never** drops message 0 (the plan digest). Stops the server silently front-truncating the protected digest.

### Fixed — "verified" is no longer a false signal (`lib/verificationHarness.js`, `main.js`)
- **Per-language syntax checks**, gated on the checker being installed (a missing tool is a *skip*, not a pass): Python (`py_compile`), TypeScript (`tsc`, syntax-error-only to avoid false module-resolution failures), Go (`gofmt -e`), Ruby (`ruby -c`), PHP (`php -l`), plus the existing JS/JSON.
- **Honest unverified state.** When nothing real could be checked (no test/lint command and an unsupported/uncheckable language), the step is reported **`[UNVERIFIED]`** and **not** stamped `[verified]` — it's still allowed through (can't gate on an impossible check), but it never claims verification it didn't do.

### Fixed — edits don't silently corrupt on Windows (`editEngine.js`, `lib/editFormats.js`)
- **CRLF + BOM preserved.** Edits normalize line endings/BOM for matching (so an LF find-block matches a CRLF file) and restore the file's original EOL/BOM on write — previously every tolerant edit silently rewrote CRLF→LF.
- **Tolerant match window scales to the find block**, so a find of more than 40 lines can match (was a hard 40-line cap).

### Fixed — agent loop & tools (`agentLoop.js`)
- **No more silently-dropped tool calls.** The per-turn cap is raised 4→8 and, if the model emitted more, it's told exactly how many didn't run (prevents state drift where the model believes an un-executed write happened).
- **Empty-`write_file` guard** rejects a mis-keyed argument that would write an empty file over real content (data loss).
- **Shell-aware.** The system prompt and `run_shell_command` description state the real shell (PowerShell on Windows, bash elsewhere); the bash-only `sudo` rewrite no longer runs on Windows.
- **Coding doctrine prompt.** Replaced the "fire a tool every turn" wall with real guidance: read before edit, prefer small targeted diffs, complete code (no placeholders), match style, run/verify before `mark_step_done`.

### Fixed — memory (`memory.js`)
- **Relevance floor** on vector retrieval (default 0.35, `XK_MEM_MIN_SIM`) so low-similarity snippets aren't injected as authoritative "facts".

### Plugin System

A **plugin system** on the level of leading coding agents': third-party folders that extend the agent with **tools**, **slash commands**, and **lifecycle hooks** — without editing core files. Plugins are trusted local code loaded in the main process, installable from a Git/URL, and declare the host capabilities they need so you consent before enabling. New engines are unit-tested (`tests/pluginSystem.test.js`); the suite is now 43 tests. Full design in `docs/superpowers/specs/2026-06-04-plugin-system-design.md`; authoring guide in `docs/PLUGINS.md`.

### Added
- **Plugin bundle format** (Approach A — industry-standard bundle style): a plugin is a folder with a `plugin.json` manifest plus convention subfolders `tools/`, `commands/`, `hooks/` (one contribution per file; auto-discovered, or listed explicitly via `contributes`). See `examples/plugins/hello` for a working tool + command + hook.
- **`lib/pluginManager.js`**: discovers/validates/loads plugins under `<userData>/plugins/`, holds the registry, persists enable + granted-capability state (`plugins.json`), routes tool/command/hook invocations, and **quarantines** a broken plugin (bad manifest, throwing module) so one bad plugin never breaks startup or the agent.
- **`lib/pluginHost.js`**: the capability-gated `host` facade handed to plugin code — `fs` (project-sandboxed), `shell`, `net` (netGuard-filtered), `memory`, `ui`, `log`. A capability you didn't declare is simply absent from `host`.
- **`lib/pluginInstaller.js`**: install from a Git/URL — host block-check via netGuard, then `git clone --depth 1` (or a GitHub-tarball download + system `tar` fallback) into a traversal-safe staging dir, manifest validation, then move into `plugins/<id>`.
- **Capability consent**: enabling a plugin shows the capabilities it requests and asks you to confirm; the host enforces only-granted caps at call time. (Honest boundary: plugins are trusted code — capabilities are transparency + defence-in-depth for honest plugins, **not** a sandbox against hostile code.)
- **Tools merge at runtime**: enabled plugin tool schemas are merged into the Build-Mode execution `tools:` array (`agentLoop.loadPluginContext` → `ctx.pluginTools`); a single generic `plugin-invoke-tool` IPC channel routes calls (no per-tool wiring). Plugin tool names are also recognised by the small-model text tool-call fallback. A tool name that collides with a core tool (or another enabled plugin) disables the offending plugin and flags it in the UI.
- **Lifecycle hooks**: `beforeToolCall`, `afterToolCall`, `onPlanApproved`, `onPlanDone`, `onMessageSend`. A `beforeToolCall` hook may veto a tool call (becomes a synthetic tool result); hook failures are logged and swallowed so a broken hook can't wedge the agent.
- **Slash commands**: typing `/<name> args` in the input expands to a plugin command's prompt template (`{{args}}`) or handler output.
- **Plugins UI** (sidebar 🧩 PLUGINS, desktop only — hidden in web mode): install-from-URL, per-plugin enable/disable with capability-consent dialog, uninstall, and surfaced `host.ui.notify` messages.
- **`lib/netGuard.js`**: new `validatePublicFetchTarget` — allows public http(s) hosts (for plugin `net` + installer downloads) while still blocking cloud-metadata / link-local / ULA hosts. Unit-tested.

## [41.3.0] - 2026-06-02

Build Mode (the durable coding agent) reliability + pro-level coding pass. No UI/markup
changes — all fixes are in the engine logic (`agentLoop.js`, `contextBuilder.js`,
`editEngine`/`editFormats`, `verificationHarness`, `planStore`, `main.js`) and renderer
wiring. A regression suite was added (`tests/agent-loop.test.js`); the full suite is now 27 tests.

### Fixed
- **Read-only / verify steps could never complete**: `run_verify` replaced the in-memory plan with the on-disk copy and wiped the per-step activity counter, so the following `mark_step_done` falsely tripped the "you haven't done any work" guard rail and the step never advanced. The activity counter is now preserved across every disk/verify sync (one shared helper, used in all three sync points).
- **Multi-step builds silently stalled**: the execution turn budget was the chat "Thinking Steps" slider (default 20) and counted every model turn, so any plan larger than a few steps ran out of turns and froze on the current step with no message. The budget now scales to the plan size (per-step allowance, the slider acts as a floor), and the agent posts a clear "reached the turn budget — paused, use Resume" notice instead of freezing.
- **`apply_edits` (batch edits) weren't tracked**: files changed via a batch edit weren't recorded on the plan, so they dropped out of context and change tracking. They're now recorded (filesTouched + ledger) and persisted like `edit_file`/`apply_patch`, on both the renderer and main-process sides.
- **BUILD MODE toggle could strand a run**: toggling build mode off mid-task hid the approve/revert controls (they live inside the build-mode panel). The toggle is now locked while a task is planning/approving/executing/under review.
- **Resuming an unapproved plan did nothing**: a resumed plan still `awaiting_approval` now runs the approval gate first instead of entering the execution loop (which only runs while `executing`) and silently returning.
- **BUILD MODE silently degraded to chat** if the plan engine failed to load; it now reports the failure instead of quietly answering as plain chat.
- **Stale agent context leak**: the per-run agent context is now cleared after a fresh build task (previously only the resume path cleaned up).

### Improved (pro-level coding)
- **No more blind edits**: a file the agent is actively editing is now shown in full when it fits the context budget, instead of being head/tail-truncated with the middle elided. The file section also gets a larger share of the prompt.
- **More reliable edits**: whitespace-tolerant search/replace now refuses ambiguous matches (instead of silently editing the first, possibly wrong, location), and unified-diff patches use the hunk's line number to anchor a repeated context/target line to the intended occurrence.
- **A real verification gate by default**: when a project has no test/lint command, verification now syntax-checks the files the step touched (JS via `node --check`, JSON via parse), so a step can't be marked complete with broken syntax.
- **Errors no longer truncated away**: long tool output (e.g. a failing test run) now preserves its tail, so the failing assertion / stack trace at the end survives.
- **Deeper working memory**: the agent retains more recent turns for continuity within a step.
- **Fewer false "infinite loop" stalls**: a single deliberate repeat of a tool call (e.g. re-running tests to recheck) is allowed rather than immediately flagged.
- **Per-step git checkpoints**: a commit is now made after each completed step (not only at the very end), so progress is recoverable mid-build.
- **Clear mode precedence**: BUILD MODE is now mutually exclusive with the Netrunner / Offline-Browser / Agent toggles, preventing those prompt-rewriting modes from leaking into a build goal.

## [41.2.1] - 2026-06-01

### Fixed
- **Massive Artifact Bloat**: Identified and resolved an issue where old `.AppImage` and `.deb` binaries from v40.7.0 were left in the project root directory. Electron-builder was recursively bundling these old 3GB+ artifacts into every new build. The workspace has been cleaned up, reducing the final application size drastically.

## [41.2.0] - 2026-06-01

### Fixed
- **Planner Render Stalls**: Resolved an issue where the agent completion of tasks would not properly trigger a DOM refresh in the sidebar, causing the UI to perpetually display Step 1. The planner now forcibly triggers an onStepAdvance UI rendering cycle every time the execution state synchronizes with the disk.
- **Explicit Task Completion**: The agent now posts a highly visible completion message in the chat feed (All Plan Steps Completed!) when it has finished all tasks in the planner, ensuring you know exactly when the full build is done.

## [41.1.0] - 2026-06-01

### Fixed
- **Planner Visual UI Desync Fix**: Resolved a critical state corruption issue inside `agentLoop.js` that caused the planner UI to visually freeze on Step 1 while the agent silently executed future steps. The agent-verification logic was incorrectly utilizing `Object.assign` without properly re-fetching array references, causing older array elements to be updated instead of the active tracking plan array. The planner UI will now reliably show the exact active step as it completes.

## [40.9.1] - 2026-06-01

### Fixed
- **Agent Progression Stall**: Fixed a critical execution loop bug where the frontend step activityCount was being wiped out by the backend plan sync at the end of every turn. This caused the agent to fail the mark_step_done guardrail repeatedly, preventing it from advancing past Phase 1 and eventually stalling out.
- **Defensive Step ID Handling**: Added fallback logic to prevent the planner from incorrectly reporting [BLOCKED step null] if an execution step is orphaned.

## [40.9.0] - 2026-06-01

### Fixed
- **Planner Sidebar Sync Bug**: Fixed a critical bug in planStore.js where approving a plan would incorrectly mark both step 1 and step 2 as active, causing the agent to skip the first step and the sidebar UI to permanently show multiple active tasks. The state is now cleanly synchronized, and the active task indicator accurately follows the agent progress.

## [40.8.0] - 2026-06-01

### Fixed
- **Planner Step Tracking**: Fixed a bug where the planner model would lose track of the agent's current progress during re-planning. The current plan digest is now correctly injected into the planning context, allowing the planner to see completed steps and the active focus.
- **Current Step Enforcement**: Enhanced the execution context to explicitly demand focus on the current step, reducing step jumping and repetition.

## [40.7.0] - 2026-06-01

### Fixed
- **Local Model Text Stalls**: Removed the overly-strict "GROUNDING" and "REASONING" text-prefix requirements from the Build Mode context builder. Forcing local models (via LM Studio) to output paragraphs of text *before* attempting a tool call was breaking their JSON tool-generation grammars, causing the `write_file` loop to stall endlessly with pure text responses like `<|channel>thought <channel|>`.
- **Code Completeness Rule**: Added a new strict directive demanding the agent output the *complete* file contents without using placeholders or comments like `// I'll fix this later`, which resolves the "lazy coding" issue during large logic tasks.

## [40.6.0] - 2026-06-01

### Fixed
- **Clean Application Build**: Removed unused CLI tools (`xagent-cli`, `build_deb.sh`) that caused conflicts during compilation. Generating `.deb` and `.AppImage` is now fully handled cleanly via `electron-builder`.
- **Infinite Loop Preventer (`agentLoop.js`)**: Implemented a hard signature check in the Build Mode execution loop. If the model fails a task and attempts to execute the exact same tool call sequence again, it is immediately caught and nudged.
- **Endless Exploration Loop (`agentLoop.js`)**: Re-anchored the loop progress checker so that if the model explores endlessly without writing to files or marking the step done, the step is automatically blocked.

## [40.4.0] - 2026-05-31

### Fixed
- **Hallucination Stalls Resolved (`agentLoop.js`)**: Fixed a critical bug where the agent would enter an endless hallucination loop if it failed to output a tool call during a long generation task. The system now injects a hard, authoritative prompt demanding a tool call, completely eliminating the "silent text-only" stalling bug.
- **True Live Chat Injection (`renderer.js` & `agentLoop.js`)**: In v40.3, user hints were appended to the chat history but weren't aggressively injected into the active execution timeline. Now, when you submit text while the agent is running, your hint is placed immediately before the AI's next internal generation tick, ensuring instant compliance and preventing the agent from "getting lost" when you manually push it to continue.

## [40.3.1] - 2026-05-31

### Fixed
- **UI Locking Syntax Error**: Resolved a syntax error in `renderer.js` that broke the main UI initialization loop, causing the application to fail to render the sign-in screen and preventing user authentication.

## [40.3.0] - 2026-05-31

### Added
- **Unlocked UI (`renderer.js`)**: The text input field is no longer disabled during agent plan execution or while awaiting approval.
- **Live Chat Injection**: Submitting text while the agent is actively executing a step or generating a plan no longer restarts or aborts the task. Instead, the message is seamlessly injected into the active `chatHistory` as a "User Hint" and is automatically appended to the agent's context on its very next iteration. This perfectly resolves the issue where the agent asks a question mid-task but the user was locked out from answering.

## [40.2.0] - 2026-05-31

### Added
- **Conversation Continuity**: preserves chat history and injects recent context into both Planning and Execution phases. No more "ignoring" follow-up instructions when entering Build Mode.
- **Grounding Mandate**: new system-level directives force the agent to verify file states and list required information before taking action.
- **Reasoning-First Execution**: the agent must now state its reasoning before every tool call, significantly reducing hallucinations and improving task transparency.
- **Mandatory Action Guard**: prevents the agent from stalling or outputting excessive conversational filler without taking functional steps.
- **Improved Remote State**: better synchronization of history and session state when using the agent via the Remote WebUI.

## [40.1.0] - 2026-05-30

### Added
- **Here I am Button**: Added a dedicated "📍 Here I am" button to the Build Mode UI allowing users to manually select and set the agent's active workspace directory.

### Fixed
- **Verification Loop Lock**: Upgraded loop-handling to aggressively prompt the model to utilize the `mark_step_done` tool when it attempts to stall or endlessly confirm completion via natural language.

## [39.9.0] - 2026-05-30

### Fixed
- **Build Mode Parity**: Synchronized Build Mode tools (`PLAN_TOOLS`) with standard agent tools (`AGENT_TOOLS`). Added missing functions like `provide_file_download_link`, `send_input`, and unified naming/descriptions for `write_file`, `run_shell_command`, and `list_directory`.
- **System Prompts**: Updated system prompts to correctly reflect version 39.9 and the full list of available tools in Build Mode.

## [39.7.0] - 2026-05-29

### Fixed
- **Build Mode Path Sandbox**: Relaxed the strict `projectRoot` path traversal sandbox. The agent can now successfully write, edit, and read from explicit absolute paths (e.g., `/home/user/Documents/gametime/`) provided by the user, while still strictly blocking malicious relative escapes (e.g., `../../etc/passwd`).

## [39.6.0] - 2026-05-29

### Fixed
- **Build Mode File Mutators**: Handled edge cases where AI agents generated tool calls using alternative JSON keys (like `file`, `path`, `text`, `code`) instead of strict schema parameters (`filepath`, `content`), which prevented file saving and editing during heavy tasks like project scaffolding.

## [39.5.0] - 2026-05-29

### Added
- Released as a consolidated stable version including all features from v50.1.0.
- Enhanced AppImage and .deb packaging.

## [50.1.0] - 2026-05-28

### Fixed — Pro-level reliability audit (esp. small models like Gemma 3n E4B)
- **`apply_patch` data loss (`lib/editFormats.js`)**: `applyUnifiedDiff` discarded every
  line *before* the first matched hunk line, silently corrupting files. Now preserves
  surrounding content and lands leading insertions at their anchor. Regression-tested.
- **Text-based tool-call fallback (`agentLoop.js`)**: small local models (Gemma 3n E4B,
  etc.) often emit tool calls as text/JSON instead of OpenAI-native `tool_calls`, which
  previously stalled the agent loop. Added a tolerant `extractToolCallsFromText`
  (handles `<tool_call>` tags, fenced ```json blocks, `parameters`/`arguments` keys,
  arrays, `tool_calls` wrappers) that only accepts real tool names so prose can't misfire.
- **Iterative planning (`agentLoop.runPlanningPhase`)**: the planner was single-shot —
  if the model ran a discovery tool (grep/read/repo-map) before `submit_plan`, the task
  aborted as `planning_failed`. It now loops, feeding tool results back, until
  `submit_plan` or a turn cap.
- **Orphaned tool messages (`contextBuilder.js`)**: budget trimming / `slice(-N)` of
  recent turns could produce a message array starting with a `role:'tool'` message that
  has no parent `tool_calls`, which strict OpenAI-compatible servers reject (HTTP 400).
  Added `sanitizeTurns` to drop orphaned tool results.
- **Verification cascade (`agentLoop.js`)**: `verifyPolicy: 'block'` ran the full
  lint/test suite before *every* `mark_step_done` and after *every* mutation, so
  intermediate multi-step work (legitimately red) blocked → 3 consecutive blocks failed
  the plan. Verification now hard-gates only the **final** step (or `verifyPolicy:
  'strict'`); mid-build failures are recorded as warnings and auto-verify is skipped to
  cut latency. The model can still call `run_verify` explicitly.
- **Web server path traversal (`main.js`)**: the static file handler did
  `path.join(__dirname, url)` with no containment, and `.js`/`.css`/`.png` paths bypass
  the auth gate — allowing unauthenticated arbitrary file reads by extension
  (`/../../secret.js`). Now decoded and contained within the app directory.
- **SSRF + arbitrary file download hardened (`lib/netGuard.js`, `main.js`,
  `standalone-server.js`)**: `/api/proxy/*` accepted any `x-target-url` (SSRF pivot into
  localhost services / cloud metadata `169.254.169.254`); it now only reaches loopback or
  the configured LLM origin, always blocks metadata/link-local, and strips
  `Authorization`/`Cookie` so the app's session token can't leak to the target.
  `set-lms-url` is validated before it feeds the allowlist. `/download_remote?file=`
  served any absolute path to an authenticated user; it's now confined (symlink-resolved)
  to the project root / app-data / downloads directories. `standalone-server.js`'s
  unauthenticated proxy is now loopback-only (override via `XK_LLM_ORIGIN`). Pure logic in
  `lib/netGuard.js`, unit-tested.
- **Tests**: `tests/durable-modules.test.js` expanded (patch correctness, search/replace
  tolerance, tool-call extraction, turn sanitization, SSRF allowlist, download path
  containment) — **14 passing**; ship-check green.

## [50.0.0] - 2026-05-28

### Added — Full-project coding agent
- **`lib/grepTool.js`**, **`lib/globTool.js`**, **`lib/repoMap.js`**, **`lib/ignoreFilter.js`**: Project search and repo map for large codebases.
- **`lib/editFormats.js`**, **`editEngine.js` v2**: Fuzzy search/replace, `apply_patch`, batch edits, 64KB write cap.
- **`lib/verificationHarness.js`**, **`lib/projectDetector.js`**: Detect test/lint commands; block `mark_step_done` until verified.
- **`lib/gitIntegration.js`**: Git init, per-step commits, undo last agent commit.
- **`lib/activeFileSet.js`**, **`lib/chatSummarizer.js`**, **`lib/planTemplates.js`**: Active file tracking, summarization, greenfield/brownfield step templates.
- **`lib/dualModelRouter.js`**: Planner vs editor model selection for build phases.
- **`agentLoop.js` v2**: Multi-tool turns (up to 4), expanded plan tools, post-mutate verify, git commit on step done.
- **`contextBuilder.js` v2**: Repo map, active files, verify hints in each turn.
- **Plan schema v2**: `testCmd`, `lintCmd`, `verifyPolicy`, `activeFiles`, `verifiedAt` per step.
- **UI**: Planner/editor model selects, plan test/lint fields, git log + undo in review.
- **Tests**: `tests/durable-modules.test.js` via `npm test`.
- **Ship check**: `npm run ship-check` (greenfield/brownfield/ledger scenarios).
- **CLI**: `cli-build.js` headless plan creation; `xagent-cli` reuses root `tools.js`.

### Changed
- **Version** 50.0.0; dependencies `fast-glob`, `ignore`, `diff-match-patch`.
- **`tools.js`**: Aligned with v50 discovery tools; fixed `memory_search` result parsing.

## [40.0.0] - 2026-05-28

### Added — Durable Memory & Planning System
- **`planStore.js`**: Plan object persisted per project (`<userData>/plans/`). Harness-owned step status, results, `filesLedger`, decisions, scratchpad.
- **`contextBuilder.js`**: Rebuilds model messages each turn from plan digest + live file excerpts + recent turns + vector memory (within `ctxSlider` budget).
- **`changeLedger.js`**: Snapshot before write/edit/delete; unified diff; `revertAll()` restores originals and deletes newly created files.
- **`editEngine.js`**: Exact → whitespace-tolerant `edit_file`; structured errors with closest-match hints; integrates with ledger.
- **`projectContext.js`**: Implicit project root (from user text or first file op); path sandbox; `list_project` tree; PowerShell on Windows / bash on Linux.
- **`agentLoop.js`**: Plan → user approval → step-by-step execution → review. Tools: `submit_plan`, `mark_step_done`, `mark_step_blocked`, `edit_file`, `run_command`, etc.
- **Build Mode toggle**: Coding workflow separated from chat. Plan panel, context slider, step tracker, diff/review UI shown only in Build Mode.
- **Agent toggle restored to chat tools**: AGENT (SYS-ACCESS) enables shell/file tools in the conversational loop without triggering plan approval.
- **Context Window slider**: Restored for Build Mode (2048–131072); drives `contextBuilder` token budgeting.
- **Resume banner**: Incomplete plans reload on startup; resume enables Build Mode automatically.
- **Project memory**: Compact task summary written to vector store at build completion (`type: project_memory`).
- **IPC**: `plan-*`, `ledger-*`, `edit-apply`, `project-*`, `agent-list-project` wired through `preload.js` and `main.js`.
- **`test-durable-modules.js`**: Smoke test for ledger, edit engine, and plan state machine.

### Changed
- **Memory model inverted**: Chat transcript is no longer authoritative during builds; Plan JSON on disk is. Fixes mid-task forgetting on long jobs.
- **Line-ranged `read_file`**: Optional `start`/`end` line parameters for large files.
- **`write_file` size cap** (~8KB in build path); large changes go through `edit_file`.
- **Generation cutoff**: No aggressive re-prune on context limit; user-visible message instead of emergency transcript wipe (build path).

### Removed
- **RESOURCE SAVER** toggle and Task Isolation flush (obsolete with durable plan memory).
- **`pruneChatHistory` aggressive logic** (`isDeepLoop`, hardcoded 131072 cap, char-budget nuking) — stub passthrough for chat path only.
- **`memory_purge`** tool from agent schema.
- **Auto-fallback plan**: Casual messages no longer forced into a 3-step plan when the model skips `submit_plan`.

### Fixed
- **`open-external-url`**: Added missing `shell` import from Electron.
- **Build vs chat routing**: "Hello" with Agent on no longer enters plan approval (requires Build Mode).

## [39.4.0] - 2026-05-28

### Removed
- **xagent-cli**: Completely removed the standalone CLI application (`xagent-cli`) and its CLI build scripts to focus entirely on the Electron desktop UI.

## [39.3.0] - 2026-05-28

### Changed
- **Context Slider Removal** *(restored in v40 for Build Mode)*: Removed from general UI in v39.3; v40 adds it back under Build Mode for `contextBuilder` token budgeting.
- **Robust Remote Downloads**: Fixed a UI crash related to binary file downloads by routing download links through Electron's native `shell` module instead of internal DOM navigation.

## [39.2.0] - 2026-05-27

### Changed
- **Ollama UI Removal**: Ollama has been removed as a user-selectable model provider in the sidebar to simplify the interface and focus on LM Studio / OpenAI compatible backends.
- **Persistent Embedding Backend**: Ollama remains the core engine for persistent vector memory and embeddings (all-minilm), ensuring backward compatibility with existing knowledge bases.
- **Forced Uplink Mode**: The application now defaults to LM Studio/OpenAI compatible mode for the primary chat interface.

## [39.1.0] - 2026-05-20

### Added
- **Dynamic System Clock**: The agent now automatically injects the current host date and time into the system prompt right before generation for both LM Studio (OpenAI format) and Ollama payloads. The AI will never assume or hallucinate the current date again.

## [38.2.0] - 2026-05-15

### Added
- **Cloudflare-Ready Download Links**: The agent can now securely serve files directly from the host machine to any remote device via a new `provide_file_download_link` tool.
- **Token-Authenticated Downloads**: Hyperlinks generated by the agent dynamically inherit the active user's session token, ensuring unauthorized access to the `/download_remote` endpoint is strictly blocked.
- **Unified Tool Schema**: Stabilized tool dispatch logic across `renderer.js` and `tools.js` to ensure the AI always has full context of available commands.
- **45% Generation Headroom**: The Context Guard now strictly limits prompt context to 55% of your slider size during loops, guaranteeing a massive 45% (thousands of tokens) dedicated purely to outputting huge code files.
- **In-Flight Wipes**: Intermediate tool outputs are now continuously wiped while the agent is running multi-step tasks, keeping the payload incredibly lean without dropping the original task instruction.
- **Auto-Recovery**: If a massive generation does hit the hard limit, the agent no longer crashes. It forces an emergency memory wipe and prompts the AI to try a chunked strategy.

## [38.1.0] - 2026-05-10

### Added
- **Task-Aware Pruning**: The agent now identifies your original task and formal `task_begin` plans, ensuring they are NEVER pruned even when context is tight.
- **Automatic Resource Guard**: When system RAM or process memory is low, the agent automatically triggers "Task Isolation" mode, flushing intermediate bloat while keeping your goals intact.
- **LM Studio Optimization**: Mathematically bound context payloads prevent "Rolling Window" thrashing and guardrail errors in LM Studio.

## [38.0.0] - 2026-05-05

### Changed
- **Ollama Stability Fixes**: Resolved issues where the agent would "hang" or "think" indefinitely when using Ollama models for complex tasks. This was caused by a missing loop continuation instruction after executing tools, which has now been fixed.
- **Improved Streaming Parser**: The Ollama stream handler now more reliably captures tool calls and content deltas, even with high-latency or high-pressure generation.
- **Resource Defaults**: RESOURCE SAVER is now toggled OFF by default. This ensures the model retains more conversational context for better reasoning, unless the user explicitly chooses to optimize for low VRAM.
- **Enhanced System Directives**: Refined the core system prompt (v38) to be more authoritative with file system and system-level tasks, ensuring the model uses tools immediately without hesitation.

## [37.9.1] - 2026-05-01

### Fixed
- **High-Contrast Chat Bubbles**: Eliminated visual halation (faint text) by redesigning chat bubbles to feature pure black text on light backgrounds, ensuring maximum readability without sacrificing the app's dark theme.
- **History & Agent Logic Restoration**: Fixed the silent agent bug (where the agent ignored prompts due to payload cloning errors) and restored the automated legacy history migration script to safely recover previously wiped chat logs.

## [37.9.0] - 2026-04-28

### Changed
- **Visual Overhaul**: Boosted the contrast, brightness, and font weight of all text in the chat interface. Solved the issue where default text, labels, and system messages appeared faded or "greyed out" against the dark background.

## [37.8] - 2026-04-25

### Fixed
- **Responsive Offline Browsing**: Fixed an issue in the Offline Web Browser where AI-generated websites lacked mobile-responsiveness constraints. The shadow DOM now forcibly injects responsive baseline CSS (like `word-wrap: break-word` and `max-width: 100%`) into all generated pages.

## [37.7] - 2026-04-20

### Fixed
- **Ollama Offline Browser Compatibility**: Ensures full compatibility with the Offline Web Browser mode when using standard Ollama models. Fixes a bug where Ollama's stream payload variations resulted in a blank white Shadow DOM.

## [37.6] - 2026-04-15

### Added
- **Offline Web Browser Mode**: Allows the agent to act as an offline web server. It dynamically generates a complete, professional HTML5/CSS webpage to present information, rendered directly in the chat via a secure Shadow DOM.

## [37.5] - 2026-04-10

### Added
- **Task Isolation (Ultra-Aggressive Pruning)**: When "Resource Saver" is enabled, the agent automatically and fully flushes its internal chat memory every time you send a new request (keeping only your new instruction and the system prompt).

## [37.4] - 2026-04-05

### Added
- **Hallucination Loop Protection**: Eliminates the "endless partial generation" bug. The agent actively monitors the stream's `finish_reason` and halts the autonomous loop if it detects an early cutoff. Uses deep-cache batch pruning to keep prompt evaluation speeds fast.

## [37.3] - 2026-04-01

### Added
- **LM Studio Context Guard**: Fixes extreme task times in LM Studio Mode caused by context window thrashing. Mathematically binds the chat history payload to 75% of your chosen Context Size.

## [37.2] - 2026-03-25

### Added
- **Active Generation Locks**: Fixes mid-task timeouts by completely locking models in VRAM (`keep_alive: -1`) while the agent is executing a multi-turn autonomous loop.

## [37.0] - 2026-03-20

### Added
- **Heavy Context Processing**: Resolves "Model timed out" errors after VRAM purges by implementing a dynamic Time-To-First-Token (TTFT) handler, allowing large models up to 15 minutes to reload.

## [36.4] - 2026-03-15

### Added
- **Predictive Resource Guard**: Multi-layered memory management system including Real-time Resource Monitoring, Adaptive Sliding Window, Visual Health Status, Dynamic History Pruning, and Autonomous Memory Purge.

## [36.2] - 2026-03-10

### Added
- **Secure Authentication**: Built-in security layer including Multi-User Support, Role-Based Access, and Encrypted Credentials (bcrypt).

## [36.0] - 2026-03-05

### Added
- **Asynchronous Background Tasks**: Natively execute, monitor, and interact with heavy system workloads via background processing, log tailing (`read_process_log`), and interactive input (`send_input`).

## [35.0] - 2026-02-28

### Added
- **Cloudflare Remote Access**: Automatic tunnels via `cloudflared` to generate secure, ephemeral URLs, plus a standalone headless server option.

## [34.0] - 2026-02-20

### Added
- **Autonomous "Plan-Execute-Verify" Workflow**: Sophisticated multi-turn autonomous loop using `task_begin` and `task_complete` for complex system tasks and research.

## [31.3] - 2026-02-10

### Added
- **Neuro-Core (Intelligent Persistent Memory)**: Low-VRAM optimization forcing `all-minilm` to run on CPU, zero-swap performance, and strict fact retention using `save_new_user_fact_only`.