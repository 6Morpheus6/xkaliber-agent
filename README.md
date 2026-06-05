# Xkaliber Agent v41.9.0 // Full-Project Local Coding Agent

Xkaliber Agent is a modern, dark-themed autonomous agent desktop client built with Electron. It connects to local **LM Studio** (OpenAI-compatible) for chat and coding, and uses **Ollama** for vector memory embeddings.

## v41.9.0 highlights — Plugin System

A **plugin system on the level of leading coding agents'**: third-party folders that extend the agent with **tools**, **slash commands**, and **lifecycle hooks** — without editing core files. Authoring guide in `docs/PLUGINS.md`; full design in `docs/superpowers/specs/2026-06-04-plugin-system-design.md`.

- **Full bundle format**: a plugin is a folder with a `plugin.json` manifest plus `tools/`, `commands/`, `hooks/` subfolders (one contribution per file, auto-discovered). Try `examples/plugins/hello`.
- **Trusted local code, installed from Git/URL**: paste `github.com/user/repo` (or any git/archive URL) in the sidebar 🧩 PLUGINS panel; the installer block-checks the host via `netGuard`, then `git clone`s (or downloads a GitHub tarball + extracts with system `tar`).
- **Declared capabilities + consent**: a manifest declares the host capabilities it needs (`fs`, `shell`, `net`, `memory`, `ui`, `log`); enabling a plugin shows them and asks you to confirm. The `host` only exposes granted caps. *(Honest boundary: plugins are trusted code — capabilities are transparency + defence-in-depth for honest plugins, not a sandbox against hostile code.)*
- **Tools, commands, hooks**: enabled plugin tools merge into the Build-Mode execution tool surface (routed through one generic IPC channel; collisions with core tools are rejected). `/command args` expands a plugin command. Hooks fire on `beforeToolCall` / `afterToolCall` / `onPlanApproved` / `onPlanDone` / `onMessageSend`, and a `beforeToolCall` hook can veto a tool call.
- **Robust**: a broken plugin (bad manifest or throwing module) is quarantined and flagged in the UI — it never breaks startup or the agent loop. New engines are unit-tested (`tests/pluginSystem.test.js`); the suite is now 43 tests.

See `CHANGELOG.md` for the full v41.9.0 entry.

## v41.3.0 highlights — Build Mode reliability + pro-level coding

This release is an engine-only pass on Build Mode (the durable coding agent). **No UI/markup changes** — the sidebar and mobile remote view are untouched; every fix is in the logic. A regression suite (`tests/agent-loop.test.js`) now covers the plan state machine end-to-end (27 tests total).

- **Steps actually advance**: `run_verify` no longer wipes the per-step activity counter, so a read-only / verify step can complete instead of getting stuck behind the "you haven't done any work" guard rail.
- **Multi-step builds finish**: the execution turn budget now scales to the plan size instead of being capped by the 20-step chat slider, so larger plans don't silently freeze on the current step. If the budget is exhausted, the agent says so and the plan stays resumable.
- **Edits are tracked and reliable**: batch `apply_edits` now records the files it changes (so they stay in context); whitespace-tolerant search/replace refuses ambiguous matches; unified-diff patches use hunk line numbers to hit the intended occurrence of a repeated line.
- **A real correctness gate**: with no test/lint command configured, verification now syntax-checks the files the step touched, so a step can't complete with broken code.
- **Editing isn't blind**: files the agent is editing are shown in full when they fit the context budget (no more head/tail truncation of the file being changed), and failing test output keeps its tail so the error survives.
- **Safer UX**: the BUILD MODE toggle is locked while a task runs (so you can't hide the approve/revert controls mid-task); resuming an unapproved plan now runs the approval gate; a missing plan engine is reported instead of silently falling back to chat; and BUILD MODE is mutually exclusive with the Netrunner / Offline-Browser / Agent toggles.
- **Per-step git checkpoints**: a commit is made after each completed step, so progress is recoverable mid-build.

See `CHANGELOG.md` for the full v41.3.0 entry.

## v41.2.1 highlights — Text Loop Prevention & Code Enforcement

This release resolves stability issues and implements strict execution guards.

This release introduces major workflow improvements, enabling the user to interact with the agent mid-task without aborting execution.

- **Unlocked Input**: The chat input field and send button are no longer disabled when the agent is executing a plan or waiting for approval.
- **Live User Hints**: Submitting text while the agent is busy running a task will now inject your message as a `User Hint` into the context, allowing you to seamlessly guide the agent or answer questions it asks mid-flight without breaking its loop.
- **Improved Interruptions**: You can now choose whether to let a task continue with your injected hint or use the stop button for hard aborts.
- **Small-model tool calling**: models that emit tool calls as text/JSON instead of OpenAI-native `tool_calls` (common with Gemma 3n E4B) no longer stall the loop — a tolerant fallback recovers calls from `<tool_call>` tags, fenced ```json blocks, and `arguments`/`parameters` shapes (only real tool names are accepted, so prose can't misfire).
- **Explore-then-plan**: the planning phase is now iterative — the model can run discovery tools (grep/read/repo-map) before `submit_plan` instead of the task aborting.
- **No mid-build cascade failures**: verification (lint/test) now hard-gates only the **final** step (or `verifyPolicy: 'strict'`); intermediate steps that are legitimately red are recorded as warnings, and the full suite is no longer re-run after every edit.
- **`apply_patch` data-loss fix**: unified-diff application previously dropped every line before the first hunk, silently corrupting files — now fixed and regression-tested.
- **Valid message arrays**: orphaned `role:'tool'` messages (which strict OpenAI servers reject with HTTP 400 on long tasks) are sanitized out.
- **Security**: web-server path traversal closed; SSRF surface on `/api/proxy/*` constrained to loopback / the configured LLM origin (cloud-metadata always blocked, session token no longer forwarded); `/download_remote` confined to the project / app-data / downloads dirs. Pure logic in `lib/netGuard.js`, unit-tested.

See `CHANGELOG.md` for the full v50.1.0 entry.

## v50 highlights

- **Discovery**: `grep_project`, `glob_files`, token-budgeted repo map, `.xkaliberignore`
- **Edits v2**: search/replace, unified diff patches, batch apply, 64KB write cap for scaffolding
- **Verification**: auto-detect test/lint commands; the lint/test gate applies to the **final** step (or every step under `verifyPolicy: 'strict'`), so multi-step builds aren't blocked by intermediate work that's legitimately red
- **Git**: init, per-step commits, undo last agent commit from review panel
- **Dual model**: separate **Planner** and **Editor** model selectors in Build Mode (local LM Studio only)
- **CLI**: `node cli-build.js "goal" [root]` creates/approves a plan headless; `npm test` and `npm run ship-check` for smoke tests

### Local model pairing (LM Studio)

| Role | Suggested model | Context |
|------|-----------------|--------|
| Planner | Smaller instruct model (7B–14B) | 8k–16k for plan + repo map |
| Editor | Stronger coder model (14B–32B) | 16k–32k for multi-file edits |

Load both models in LM Studio, pick them in the Build sidebar, or set `localStorage` keys `xkaliber_planner_model` / `xkaliber_editor_model`.

**Running a single small model (e.g. Gemma 3n E4B)?** Leave Planner and Editor on the same model — v50.1.0's text tool-call fallback, iterative planning, and relaxed verification gating are tuned so a single small model can plan and edit reliably. Give it as much context as your hardware allows (8k+ recommended) since the repo map and live file excerpts share that budget.

## Operating modes

| Mode | Toggle | Use for |
|------|--------|---------|
| **Chat** | Default (both off) | Hello, Q&A, casual conversation |
| **Agent** | AGENT (SYS-ACCESS) | One-off tools: read/write files, shell, web search — no plan approval |
| **Build** | BUILD MODE (CODING) | Multi-step projects: plan → approve → execute → review |

**Build Mode** uses the durable memory system (plan on disk, not chat history). **Agent** does not trigger planning — say hello without a task manager asking for approval.

### 🚀 NEW in v40.0.0: Durable Memory & Build Mode

- **Plan as source of truth**: Multi-step coding tasks persist goal, steps, decisions, and file ledger to disk (`<userData>/plans/`). Context is rebuilt each turn from plan state + live files — the model no longer "forgets" mid-build.
- **Build Mode toggle**: Separates coding workflows from general chat. Plan approval, step tracker, diff review, and context slider appear only in Build Mode.
- **Change ledger**: Snapshots before every write/edit/delete; unified diff at end; **Revert All** restores pre-task file state.
- **Edit engine**: Targeted `edit_file` (search/replace) with whitespace-tolerant matching; `write_file` capped for small/new files.
- **Project sandbox**: File and shell ops scoped to an inferred project root; path traversal rejected; **PowerShell on Windows**, bash on Linux.
- **Crash resume**: Plans autosave after every tool call; reopen the app to resume an interrupted build.
- **Removed for build path**: Transcript pruning (`isDeepLoop`), Task Isolation flush, and RESOURCE SAVER toggle (obsolete once memory is durable).

### Quick start (Build Mode)

1. Start LM Studio with a model loaded at `http://localhost:1234`
2. Run `npm install` && `npm start`
3. Enable **BUILD MODE (CODING)** in the sidebar
4. Describe a coding task → review plan → **APPROVE PLAN** → agent executes step-by-step
5. On completion: review diff, optionally **REVERT ALL**

Smoke-test core engines: `npm test` and `npm run ship-check`

Headless plan bootstrap: `node cli-build.js "Add auth module" ./my-repo`

Optional interactive CLI (Ollama): `node xagent-cli/index.js` — shares `tools.js` with the desktop app.

### 🚀 NEW in v39.3.0: Handled Context by LM Studio & UI Cleanup
- **Context Slider Removal** *(restored in v40 for Build Mode)*: The manual context limit slider was removed from the general UI; v40 reintroduces it under Build Mode for plan-driven context budgeting.
- **Robust Remote Downloads**: Fixed a UI crash related to binary file downloads by routing download links through Electron's native `shell` module instead of internal DOM navigation.
- **Ollama UI Removal**: Ollama support has been entirely dropped from the primary user interface to streamline the user experience. The application now exclusively uses LM Studio/OpenAI compatible backends for inference.
- **Forced Uplink Mode**: The application now defaults to LM Studio/OpenAI compatible mode for primary inference.

### 🚀 NEW in v39.1.0: Dynamic System Clock
- **Always-Accurate Time Awareness**: The agent now dynamically calculates the exact host system date and time and injects it securely into the system prompt right before connecting to the model API. This guarantees the AI always knows the current date without hallucinating, guessing, or requiring a time-check tool turn.

### 🚀 NEW in v38.2.0: Ultra-Aggressive Loop Guard
- **45% Generation Headroom**: The Context Guard now strictly limits prompt context to 55% of your slider size during loops, guaranteeing a massive 45% (thousands of tokens) dedicated purely to outputting huge code files.
- **In-Flight Wipes**: Intermediate tool outputs are now continuously wiped while the agent is running multi-step tasks, keeping the payload incredibly lean without dropping the original task instruction.
- **Auto-Recovery**: If a massive generation does hit the hard limit, the agent no longer crashes. It forces an emergency memory wipe and prompts the AI to try a chunked strategy.
- **Cloudflare-Ready Download Links**: The agent can now securely serve files directly from the host machine to any remote device via a new `provide_file_download_link` tool.
- **Token-Authenticated Downloads**: Hyperlinks generated by the agent dynamically inherit the active user's session token, ensuring unauthorized access to the `/download_remote` endpoint is strictly blocked.

### 🚀 NEW in v38.1.0: Task-Aware Context Guard
- **Task-Aware Pruning**: The agent now identifies your original task and formal `task_begin` plans, ensuring they are NEVER pruned even when context is tight.
- **Automatic Resource Guard**: When system RAM or process memory is low, the agent automatically triggers "Task Isolation" mode, flushing intermediate bloat while keeping your goals intact.
- **LM Studio Optimization**: Mathematically bound context payloads prevent "Rolling Window" thrashing and guardrail errors in LM Studio.

### 🚀 NEW in v38.0.0: Ollama Reliability & Performance
- **Ollama Stability Fixes**: Resolved issues where the agent would "hang" or "think" indefinitely when using Ollama models for complex tasks. This was caused by a missing loop continuation instruction after executing tools, which has now been fixed.
- **Improved Streaming Parser**: The Ollama stream handler now more reliably captures tool calls and content deltas, even with high-latency or high-pressure generation.
- **Resource Defaults**: RESOURCE SAVER is now toggled OFF by default. This ensures the model retains more conversational context for better reasoning, unless the user explicitly chooses to optimize for low VRAM.
- **Enhanced System Directives**: Refined the core system prompt (v38) to be more authoritative with file system and system-level tasks, ensuring the model uses tools immediately without hesitation.

### 🚀 NEW in v37.9.1: Critical Core & UI Hotfixes
- **High-Contrast Chat Bubbles**: Eliminated visual halation (faint text) by redesigning chat bubbles to feature pure black text on light backgrounds, ensuring maximum readability without sacrificing the app's dark theme.
- **History & Agent Logic Restoration**: Fixed the silent agent bug (where the agent ignored prompts due to payload cloning errors) and restored the automated legacy history migration script to safely recover previously wiped chat logs.

### 🚀 NEW in v37.9.0: Enhanced UI Readability
- **Visual Overhaul**: Boosted the contrast, brightness, and font weight of all text in the chat interface. Solved the issue where default text, labels, and system messages appeared faded or "greyed out" against the dark background.

### 🚀 NEW in v37.8: Responsive Offline Browsing
- Fixed an issue in the Offline Web Browser where AI-generated websites lacked mobile-responsiveness constraints, causing content and text to bleed off the right side of the screen. The shadow DOM now forcibly injects responsive baseline CSS (like `word-wrap: break-word` and `max-width: 100%`) into all generated pages to ensure they remain perfectly readable within the chat window.

### 🚀 NEW in v37.7: Ollama Offline Browser Compatibility
- This update ensures full compatibility with the Offline Web Browser mode when using standard Ollama models. It fixes a bug where Ollama's stream payload variations (json.response vs json.message.content depending on the API endpoint used) resulted in a blank white Shadow DOM.

### 🚀 NEW in v37.6: Offline Web Browser Mode
- A highly requested feature that allows the agent to act as an offline web server. By enabling the OFFLINE BROWSER toggle, the agent will stop responding in conversational markdown. Instead, it will dynamically generate a complete, beautifully themed, professional HTML5/CSS webpage to present the information you requested (e.g., generating a full Wiki-style article layout when you research a topic). The generated site is rendered directly in the chat via a secure Shadow DOM, providing a highly immersive browsing experience.

### 🚀 NEW in v37.5: Task Isolation (Ultra-Aggressive Pruning)
- This version perfectly aligns with the goal of preventing resource exhaustion during massive coding tasks. When "Resource Saver" is enabled, the agent will now automatically and fully flush its internal chat memory every time you send a new request (keeping only your new instruction and the system prompt). This completely isolates the new task, guaranteeing that 100% of your chosen Context Size is dedicated solely to generating code and analyzing tool outputs, without any bloat from previous conversations.

### 🚀 NEW in v37.4: Hallucination Loop Protection
- This update completely eliminates the "endless partial generation" bug caused when LM Studio reaches its maximum context limit mid-generation. The agent now actively monitors the stream's `finish_reason`—if it detects an early cutoff, it instantly halts the autonomous loop and warns the user, rather than endlessly nudging the model to fix broken JSON. Additionally, the Context Guard now uses deep-cache batch pruning to keep LM Studio's prompt evaluation speeds fast over long coding tasks.

### 🚀 NEW in v37.3: LM Studio Context Guard
- This version fixes extreme task times in LM Studio Mode caused by context window thrashing. The agent now mathematically binds the chat history payload to 75% of your chosen Context Size slider setting, guaranteeing a 25% VRAM headroom for the model's actual response. This prevents LM Studio's internal "rolling window" policy from triggering mid-generation and destroying the prompt cache.

### 🚀 NEW in v37.2: Active Generation Locks
- This version fixes mid-task timeouts by completely locking models in VRAM (`keep_alive: -1`) while the agent is executing a multi-turn autonomous loop. Once the task is fully complete, it applies the appropriate memory saver policy, preventing tools that take several minutes (like building or scraping) from causing the model to be prematurely flushed.

### 🚀 NEW in v37.0: Heavy Context Processing
- This version resolves the "Model timed out" errors that occurred after VRAM purges by implementing a dynamic Time-To-First-Token (TTFT) handler, allowing large models up to 15 minutes to reload and parse heavy contexts without dropping the connection. It also includes new UI feedback for the warm-up phase.

### 🚀 NEW in v36.4: Predictive Resource Guard
- This version introduces a multi-layered memory management system designed to prevent system RAM and VRAM congestion during heavy autonomous workloads (e.g., building applications, large-scale research).
- **Real-time Resource Monitoring**: The backend now continuously monitors system RAM and process memory, signaling the frontend to adapt before congestion hits.
- **Adaptive Sliding Window**: Automatically adjusts context length and truncation intensity based on hardware pressure.
- **Visual Health Status**: Monitor your system's "breathing room" directly from the UI.
- **Resource Saver Mode**: A new UI toggle that enables aggressive context pruning and message trimming.
- **Dynamic History Pruning**: Automatically drops intermediate conversation turns and trims massive tool outputs in older messages to keep the context window lean and prevents system RAM bloat.
- **Autonomous Memory Purge**: The agent can now call the `memory_purge` tool to request a resource cleanup when it detects resource congestion or before starting a massive generation task.
- **Optimized Keep-Alive**: Automatically reduces model retention time in VRAM when "Resource Saver" is active, ensuring your system stays responsive.

## 🌟 Key Features

### 🛡️ Secure Authentication (v36.2)
The agent now includes a built-in security layer to protect your local workspace.
- **Multi-User Support**: Create separate accounts with unique credentials.
- **Role-Based Access**: Admins can approve new users and toggle access to sensitive system tools.
- **Encrypted Credentials**: All passwords are hashed locally using industrial-strength bcrypt encryption.

### ⚙️ Asynchronous Background Tasks (v36)
The agent can now natively execute, monitor, and interact with heavy system workloads (like kernel builds or server instances) without blocking or timing out.
- **Background Processing**: Shell commands can be spawned asynchronously, bypassing default output buffer limits and time constraints.
- **Log Tailing**: The agent uses `read_process_log` to safely poll the last 50-2000 lines of a running job's stdout without blowing up its context window.
- **Interactive Input**: The `send_input` tool allows the agent to pipe Y/n responses or passwords directly into the stdin of active background processes, unblocking stalled commands.

### 🌐 Cloudflare Remote Access (v35)
Easily access your local Xkaliber Agent from anywhere.
- **Automatic Tunnels**: The agent automatically downloads and configures cloudflared to generate a secure, ephemeral `.trycloudflare.com` URL on startup.
- **Standalone proxy**: Headless Linux/CLI users can run `node standalone-server.js` as a lightweight CORS proxy to a local LLM (it does **not** serve the app UI or include auth). As of v50.1.0 its proxy is restricted to loopback by default — set `XK_LLM_ORIGIN` to allow a specific remote LLM origin. Do not expose it directly to the public internet.

### 🤖 Build Mode: Plan-Execute-Review (v40)
When **BUILD MODE** is enabled, the agent runs a disk-backed coding loop designed for long multi-file projects on small local models.
- **Planning**: Model submits `submit_plan` with goal and ordered steps; you edit and approve in the sidebar.
- **Execution**: One step at a time; harness updates step status from tool outcomes (never from model prose).
- **Context**: `contextBuilder` rebuilds messages each turn — goal, decisions, current step, and live file excerpts always survive budget pressure.
- **Review**: Unified diff from the change ledger; one-click revert.
- **Resume**: Close the app mid-task and reopen — execution continues from the saved plan.

**Agent mode** (without Build) keeps the conversational multi-turn loop with shell/file tools — suitable for quick tasks without formal planning.

### 🧩 Plugin System (v42)
Extend the agent with **tools**, **slash commands**, and **lifecycle hooks** shipped as trusted local folders — no core edits. Authoring guide: `docs/PLUGINS.md`.
- **Bundle format**: `plugin.json` manifest + `tools/`, `commands/`, `hooks/` (one contribution per file; auto-discovered). Example: `examples/plugins/hello`.
- **Install from Git/URL**: sidebar 🧩 PLUGINS → paste a repo/archive URL → INSTALL → enable (with capability consent). Manual: drop a folder in `<userData>/plugins/<id>/`.
- **Capabilities**: a manifest declares `fs` / `shell` / `net` / `memory` / `ui` / `log`; the cap-gated `host` exposes only what you grant. *Plugins run trusted code — capabilities are transparency + defence-in-depth for honest plugins, not a sandbox.*
- **Hooks**: `beforeToolCall` (can veto), `afterToolCall`, `onPlanApproved`, `onPlanDone`, `onMessageSend`. A broken plugin is quarantined and flagged, never breaking the agent.
- **Engines**: `lib/pluginManager.js`, `lib/pluginHost.js`, `lib/pluginInstaller.js`; installs go through `lib/netGuard.js` (metadata/link-local/ULA always blocked).

### 🧠 Neuro-Core (Intelligent Persistent Memory)
The agent features a robust long-term memory engine powered by local embeddings.
- **Low-VRAM Optimization (v31.3)**: The `all-minilm` embedding model is now strictly forced to run on the CPU, preventing VRAM contention and application hangs on systems with limited GPU memory.
- **Zero-Swap Performance**: By offloading embeddings to the CPU, Xkaliber Agent no longer needs to unload your primary chat model to perform memory searches, resulting in significantly faster and more stable retrieval.
- **Strict Fact Retention**: The agent is heavily constrained to avoid saving casual conversation. It autonomously decides to use the `save_new_user_fact_only` tool to vectorize and save only highly important, permanent user preferences, facts, or project details.
- **Embeddings Engine**: Utilizes the `all-minilm` model. If Ollama doesn't have it installed, Xkaliber Agent will securely stream and auto-download it on startup.
- **Main Process Storage**: Memory vector databases are safely written to the user's local disk via IPC.
- **UI Feedback**: Features a real-time `[X MEMS]` counter and a flashing `[ NEURO-CORE SAVING... ]` indicator.

### 👻 GhostTrace Diagnostics System
- **Shell Execution**: The agent can run bash commands directly on your host machine to navigate, modify files, and manage the system.
- **Secure Sudo Injection**: A password field in the UI allows you to provide your sudo password. When the agent attempts a command requiring root privileges, the application dynamically intercepts and pipes your password.
- **Guard Rails**: Strict system prompts prevent the agent from modifying files or configurations unprompted.

### 🛠️ Agent & Build Tools
The UI shows transparent execution logs (`⚡ tool_name`).

**Build Mode tools** (`agentLoop.js`):
- Plan: `submit_plan`, `mark_step_done`, `mark_step_blocked`, `record_decision`, `init_project`
- Discovery: `grep_project`, `glob_files`, `get_repo_map`, `list_project`, `read_file` (optional line range)
- Edit: `edit_file`, `apply_edits` (batch), `apply_patch` (unified diff), `write_file` (≤64KB), `delete_file`
- Context: `add_files`, `drop_files` (pin/unpin files in the live context)
- Exec/verify: `run_command`, `run_verify`, `set_project_root`, `read_process_log`
- Memory/web: `search_memory`, `save_fact`, `web_search`

**Agent mode tools** (chat loop):
- `run_shell_command`, `read_file`, `write_file`, `list_directory`, `delete_file`
- `save_new_user_fact_only`, `memory_search`, `web_search`
- `read_process_log`, `send_input`, `provide_file_download_link`

### 🌐 Netrunner (Web Access)
- Equips the agent with real-time web search capabilities using a secure DuckDuckGo HTML scraper (bypassing CORS and API key requirements).
- **Conversational Synthesis**: Web data is injected securely into the prompt, forcing the LLM to read the data and respond with a natural, flowing, first-person narrative essay, strictly avoiding bulleted lists or markdown tables.

### 🔊 Audio Uplink (TTS) & Multimodal
- **Piper TTS**: High-quality, offline Text-to-Speech integration (`en_US-lessac-medium`).
- **📎 Enhanced File Attachments**: Robust file handling with support for images and text documents.
- **Vision Integration**: Images are auto-encoded for seamless multimodal analysis with vision models.
- **Context Optimization**: Large text files are intelligently truncated to fit context limits, with full access provided via the `read_file` agent tool.
- **Drag-and-Drop**: Supports both button-based uploads and direct file dropping into the chat.

## ⚙️ Development & Build Instructions

### Prerequisites
- Node.js (v18+)
- **LM Studio** (or any OpenAI-compatible server) for chat/coding — default `http://localhost:1234`
- **Ollama** (optional) for vector memory embeddings (`all-minilm`)

### Setup
```bash
# Install dependencies
npm install

# Start the Electron app
npm start
```

### Architecture (Build Mode)

| Module | Role |
|--------|------|
| `planStore.js` | Plan JSON CRUD + state machine |
| `contextBuilder.js` | Rebuild model context from plan + files |
| `changeLedger.js` | Snapshots, diff, revert-all |
| `editEngine.js` | Tolerant search/replace edits |
| `projectContext.js` | Project root, sandbox, cross-platform shell |
| `agentLoop.js` | Plan → approve → execute → review |
| `lib/pluginManager.js` | Plugin discovery/registry, enable + cap state, tool/command/hook routing |
| `lib/pluginHost.js` | Capability-gated `host` facade for plugin code |
| `lib/pluginInstaller.js` | Install plugins from Git/URL (netGuard-checked) |

### Testing

The durable engines and the agent loop are unit-testable in plain Node (no Electron). Run the suite:

```bash
npm test          # runs node --test "tests/*.test.js"
```

`tests/durable-modules.test.js` covers the ledger, edit engine, edit formats, repo map, net guard, and verification harness. `tests/agent-loop.test.js` covers the plan state machine: step advancement, the verify/guard-rail interaction, the turn budget, batch-edit tracking, context building, and the syntax-check verification fallback. `tests/pluginSystem.test.js` covers the plugin engines: discovery, manifest validation, quarantine of broken plugins, tool-name collisions, contribution-path traversal rejection, enable/cap persistence, the capability-gated host (fs sandbox, net guard, memory), and the installer (URL block-check, staging, GitHub-tarball resolution). Prefer these over the legacy `node test-durable-modules.js` smoke script, which does not assert step advancement.