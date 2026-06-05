# CLAUDE.md — Xkaliber Agent

Working notes for AI assistants (and humans) operating in this repo. Read this before touching code.

## What this is

A **local AI assistant** that talks to a locally-hosted, OpenAI-compatible LLM server (LM Studio by default; Ollama's `/v1` endpoint also works) and can use tools (shell, file read/edit/write, web search, vector memory, WhatsApp, TTS). It ships as an **Electron desktop app** with a built-in web server so the same UI can be reached from a phone or over a Cloudflare tunnel.

It has **two operating modes**, chosen by the agent toggle in the UI:

- **Agent mode ON** → the **durable plan loop** (`agentLoop.js`): plan → user approval → autonomous step-by-step execution → end review. This is the coding agent. It does **not** use the old transcript pruning.
- **Agent mode OFF** → the **legacy chat path** (`sendMessage` in `renderer.js`): ordinary conversational chat. Still uses the old `pruneChatHistory`, which only matters for chat now.

The owner's goal: a coding agent that builds/edits full projects across many steps on a small local model, without forgetting mid-task. **That forgetting problem is solved** in agent mode (see below).

## Backend protocol reality

`uplinkMode` is **hardcoded `true`** (`renderer.js`, "Ollama removed from UI in v39.4"). The whole app speaks **OpenAI chat-completions format only**. `currentApiBase` defaults to `http://localhost:1234` (LM Studio) and is set from the server input. The agent loop calls `${apiBase(base)}/v1/chat/completions`; `apiBase()` normalizes trailing `/`, `/v1`, `/api`. The native Ollama `/api` is used **only** for embeddings (`memory.js`) — not for chat. Do not add Ollama-native (`/api/chat`, newline-JSON) parsing; it would be dead code.

## Architecture — the durable agent system (agent mode)

| Module | Responsibility | Runs in |
|---|---|---|
| `agentLoop.js` | The plan loop: `PLAN_TOOLS`, `executeAgentTool`, `runPlanningPhase`, `waitForApproval`, `runExecutionPhase`, `runReviewPhase`, `runAgentTask`. Exposed as `window.XKAgentLoop`. | renderer |
| `contextBuilder.js` | Rebuilds the model's message array each turn from plan state. Exposed as `window.XKContextBuilder`. | renderer |
| `planStore.js` | Plan object CRUD + state machine (`approve`, `markStepDone`, `markStepBlocked`, `recordFileTouch`). Plans in `<userData>/plans/`. | main (IPC) |
| `changeLedger.js` | Snapshot originals before write/edit/delete; unified diff; `revertAll`. Ledger in `<userData>/ledger/<planId>/`. | main (IPC) |
| `editEngine.js` | Targeted search/replace edits: exact → whitespace-tolerant → closest-region error. `write_file` size cap (~8KB) routes big content to `edit_file`. | main (IPC) |
| `projectContext.js` | The working **project root** + path sandboxing + cross-platform shell (`powershell.exe` on Windows) + `listProjectTree` (skips `node_modules`, `.git`, `dist`, etc.). | main (IPC) |
| `lib/pluginManager.js` + `lib/pluginHost.js` + `lib/pluginInstaller.js` | **Plugin system** (trusted local folders under `<userData>/plugins/`). Plugins add tools/commands/hooks; manifests declare capabilities; the host facade is cap-gated. Install from Git/URL via netGuard + system `git`/`tar`. See `docs/PLUGINS.md` and the spec under `docs/superpowers/specs/`. | main (IPC) |

### Plugin system (added v41.3+)

Plugins extend the **execution** tool surface, slash commands, and lifecycle hooks without editing core files. The four-places rule (`PLAN_TOOLS` ↔ `executeAgentTool` ↔ IPC ↔ preload) does **not** apply to plugin tools: they flow through **one** generic IPC channel (`plugin-invoke-tool`) and are merged into the execution `tools:` array at runtime (`agentLoop.loadPluginContext` → `ctx.pluginTools`). `executeAgentTool`'s fallthrough routes unknown-but-known-plugin names there. Hooks fire via `fireHookSafe` (`beforeToolCall`/`afterToolCall`/`onPlanApproved`/`onPlanDone`/`onMessageSend`); a `beforeToolCall` veto becomes a synthetic tool result. Capabilities (`fs/shell/net/memory/ui/log`) are **transparency + honest-plugin defence-in-depth, not a sandbox** — plugins are trusted code. Engines are unit-tested in `tests/pluginSystem.test.js` (`npm test`).

Renderer entry points: `runPlanAgentTask` (fresh task) and `runResumedAgentTask` (resume), both built via the same ctx fields. `index.html` loads `contextBuilder.js` then `agentLoop.js`. IPC channels (`plan-*`, `edit-apply`, `ledger-*`, `project-*`, `agent-list-project`) are whitelisted in `preload.js` and handled in `main.js` (~line 414+).

### How the forgetting problem is solved

The chat transcript is **no longer the memory**. The **Plan object** (JSON on disk) is the source of truth: `goal`, ordered `steps` (status/result/filesTouched), `filesLedger`, `decisions`, `scratchpad`. The harness updates it deterministically from tool results — the model is never trusted to remember.

Each execution turn, `contextBuilder.buildExecutionContext` rebuilds the message array within the active `num_ctx` budget:
1. **System + plan digest** (goal, decisions, every step's status, the current step, scratchpad) — **always message 0, never dropped.**
2. Current file excerpts (live from disk).
3. Last ~4 raw turns.
4. Retrieved long-term memory.
Items 2–4 are dropped from the bottom when the budget is tight; 1 is tiny and always present. The plan **autosaves after every tool call**, so closing the app mid-task and reopening **resumes** from disk.

### The plan lifecycle

`submit_plan` → `awaiting_approval` (UI plan panel, editable steps) → user approves → `executing` (one step at a time; `mark_step_done` advances; `mark_step_blocked` **skips to the next step**, with a 3-consecutive-block ceiling that fails the plan) → `done` → review panel shows the unified diff + **Revert All**.

## Environment reality

- **Not a git repo.** No version control. Recovery is via the change ledger (`ledger-revert-all`), not git. Be careful — consider `git init` before large refactors.
- **Owner runs Windows 11.** The agent tools are cross-platform now (`projectContext.getShellConfig()` → PowerShell on Windows; paths sandboxed to the project root). The **legacy** chat-path tools and the standalone CLI still assume bash/Linux.
- Embeddings model `all-minilm` is auto-pulled by `memory.js` (CPU). `memory.js queryVectors` returns `{success, data}` — the renderer's `searchMemory` unwraps it correctly.
- No test runner. Quick smoke test of the durable engines: `node test-durable-modules.js`.

## How to work here

1. **Don't assume anything works — run it.** Engines are unit-testable in plain node (require the module, drive it, assert). The core engines have been verified this way (snapshot/diff/byte-exact revert, tolerant edit matching, no-match feedback, path-traversal rejection, the step machine).
2. **Know which path you're in.** Agent mode = `agentLoop.js`/`contextBuilder.js`. Chat mode = `sendMessage`/`pruneChatHistory`. A fix in one does not touch the other.
3. **Keep the fresh and resume ctx in sync.** They were divergent once (resume crashed because it lacked `onStepUpdate`/`onStepAdvance`/`onPlanBlocked` and `runReviewPhase` wasn't exported — now fixed). If you add a ctx callback, add it to both `runPlanAgentTask` and `runResumedAgentTask`, or refactor to a shared builder.
4. **Tool name ↔ handler ↔ schema must match.** Agent tools live in three places that must agree: `PLAN_TOOLS` (agentLoop.js), the `executeAgentTool` switch (agentLoop.js), and the `main.js` IPC handler. Preload must whitelist any new channel.
5. **State is harness-owned, not model-owned.** Step status, file ledger, decisions are written by code from tool outcomes — never parsed from model prose. Preserve this; it's why a 7B model doesn't lose the thread.
6. **Security still applies.** The web server binds `0.0.0.0` and can be tunneled publicly; shell/file tools run unsandboxed at the OS level (the project-root sandbox is logical, enforced in `projectContext.resolvePath`, not an OS jail). Treat networking changes as security-sensitive.
7. Vanilla JS, CommonJS, no framework/bundler/TypeScript. Match surrounding style.

## Known-broken / sharp edges (legacy, off the agent path)

These are in code the agent loop no longer uses, but still live:

- `tools.js` (CLI): `delete_file`, `read_process_log`, `send_input`, `memory_purge` declared but unhandled → silent no-ops; `memory_search` reads `.length` on `{success,data}` → always "No memory found". The new `agentLoop.executeAgentTool` implements all of these correctly.
- `standalone-server.js` serves no UI — the README's "securely expose to the internet" claim is still overstated (it only proxies; no app).

Fixed in v50.1.0 (previously sharp edges): `open-external-url` (`shell` is now imported); the `main.js` static web handler now contains paths within `__dirname`; and the SSRF/download surface is constrained via `lib/netGuard.js` — `/api/proxy/*` now only reaches loopback or the configured LLM origin (metadata/link-local always blocked, `Authorization`/`Cookie` stripped), `set-lms-url` is validated, `/download_remote?file=` is confined to the project root / app-data / downloads dirs (symlink-resolved), and `standalone-server.js`'s proxy is loopback-only (override with `XK_LLM_ORIGIN`).

## Useful entry points when debugging

- Coding agent behavior / context → `agentLoop.js` (`runExecutionPhase`) + `contextBuilder.js`.
- A tool "does nothing" → check `PLAN_TOOLS` ↔ `executeAgentTool` ↔ `main.js` IPC ↔ `preload.js` whitelist.
- Edit won't apply → `editEngine.apply` (exact → whitespace-tolerant → closest-region error); the model retries up to 3 times before the step is blocked.
- Plan not persisting / resume issues → `planStore` save/load + the per-tool `plan-save` in `runExecutionPhase`.
- Wrong files in context → `contextBuilder` file selection (`currentStep.filesTouched` + last 8 `filesLedger` keys) and `projectContext.listProjectTree` ignore-list.
