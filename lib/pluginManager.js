/**
 * Plugin manager (main process).
 *
 * Discovers plugin folders under <userData>/plugins/, validates manifests, loads
 * their tool/command/hook contributions, holds the registry, persists enable/cap
 * state, and routes tool/command/hook invocations through a capability-gated host.
 *
 * Trusted-code model (see lib/pluginHost.js + the design spec). One bad plugin is
 * quarantined, never allowed to break discovery or the agent loop.
 *
 * Dependency-injected for `node --test`: pass `fsImpl`, `pathImpl`, `requireImpl`
 * etc. in tests; in production it defaults to the real node modules.
 */

const pluginHost = require('./pluginHost.js');

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const CONTRIB_KINDS = ['tools', 'commands', 'hooks'];
const HOOK_EVENTS = ['beforeToolCall', 'afterToolCall', 'onPlanApproved', 'onPlanDone', 'onMessageSend'];

class PluginManager {
    constructor(userDataPath, deps = {}) {
        this.fs = deps.fsImpl || require('fs');
        this.path = deps.pathImpl || require('path');
        // requireImpl lets tests inject fake modules instead of touching disk.
        this.requireModule = deps.requireImpl || ((abs) => {
            delete require.cache[require.resolve(abs)];
            return require(abs);
        });
        this.log = deps.logger || ((m) => console.log(`[plugins] ${m}`));

        this.pluginsDir = this.path.join(userDataPath, 'plugins');
        this.stateFile = this.path.join(this.pluginsDir, 'plugins.json');

        // Injected host backends (all optional; gated by declared caps anyway).
        this.projectContext = deps.projectContext || null;
        this.runCommand = deps.runCommand || null;       // (cmd) => Promise<{stdout,stderr,error}>
        this.memory = deps.memory || null;               // { store, query }
        this.uiNotify = deps.uiNotify || (() => {});     // (pluginId, msg) => void
        this.netGuard = deps.netGuard || null;
        this.fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
        // Core agent tool names plugins must not shadow.
        this.coreToolNames = new Set(deps.coreToolNames || []);

        // id -> { manifest, dir, enabled, grantedCaps, tools, commands, hooks, error }
        this.registry = new Map();
        this.state = {}; // persisted: id -> { enabled, grantedCaps, source, version, installedAt }
    }

    // ---- persistence -------------------------------------------------------

    _ensureDir() {
        try { this.fs.mkdirSync(this.pluginsDir, { recursive: true }); } catch (e) { /* exists */ }
    }

    loadState() {
        try {
            const raw = this.fs.readFileSync(this.stateFile, 'utf8');
            this.state = JSON.parse(raw) || {};
        } catch (e) {
            this.state = {};
        }
        return this.state;
    }

    saveState() {
        this._ensureDir();
        this.fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf8');
    }

    // ---- discovery ---------------------------------------------------------

    /** Scan the plugins dir, (re)build the registry. Safe to call repeatedly. */
    discover() {
        this._ensureDir();
        this.loadState();
        this.registry.clear();

        let entries = [];
        try {
            entries = this.fs.readdirSync(this.pluginsDir, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
        } catch (e) {
            entries = [];
        }

        for (const dirName of entries) {
            const dir = this.path.join(this.pluginsDir, dirName);
            try {
                this._loadPlugin(dir, dirName);
            } catch (e) {
                // Quarantine: record the error, keep going. Never throw out of discover.
                const msg = e.message || String(e);
                this.registry.set(dirName, {
                    manifest: { id: dirName, name: dirName, version: '0.0.0', capabilities: [] },
                    dir, enabled: false, grantedCaps: [],
                    tools: [], commands: [], hooks: [],
                    loadError: msg, error: msg,
                });
                this.log(`quarantined ${dirName}: ${e.message}`);
            }
        }

        this._resolveToolCollisions();
        return this.list();
    }

    _readManifest(dir, dirName) {
        const manifestPath = this.path.join(dir, 'plugin.json');
        const raw = this.fs.readFileSync(manifestPath, 'utf8'); // throws if missing -> quarantine
        let m;
        try { m = JSON.parse(raw); } catch (e) { throw new Error(`invalid plugin.json: ${e.message}`); }

        const id = m.id || dirName;
        if (!ID_RE.test(id)) throw new Error(`invalid plugin id "${id}" (use [a-z0-9-])`);
        const caps = pluginHost.validCaps(m.capabilities || []);
        return {
            id,
            name: m.name || id,
            version: typeof m.version === 'string' ? m.version : '0.0.0',
            description: m.description || '',
            author: m.author || '',
            capabilities: caps,
            contributes: m.contributes && typeof m.contributes === 'object' ? m.contributes : null,
        };
    }

    /** Resolve a contribution file path and reject traversal outside the plugin dir. */
    _safeContribPath(dir, rel) {
        const abs = this.path.resolve(dir, rel);
        const relCheck = this.path.relative(dir, abs);
        if (relCheck.startsWith('..') || this.path.isAbsolute(relCheck)) {
            throw new Error(`contribution path escapes plugin dir: ${rel}`);
        }
        return abs;
    }

    _listContribFiles(plugin, kind) {
        const contributes = plugin.manifest.contributes;
        if (contributes && Array.isArray(contributes[kind])) {
            return contributes[kind].map((rel) => this._safeContribPath(plugin.dir, rel));
        }
        // Auto-discover: <dir>/<kind>/*.js
        const kindDir = this.path.join(plugin.dir, kind);
        let files = [];
        try {
            files = this.fs.readdirSync(kindDir)
                .filter((f) => f.endsWith('.js'))
                .map((f) => this.path.join(kindDir, f));
        } catch (e) { files = []; }
        return files;
    }

    _loadPlugin(dir, dirName) {
        const manifest = this._readManifest(dir, dirName);
        const st = this.state[manifest.id] || {};
        const plugin = {
            manifest,
            dir,
            enabled: !!st.enabled,
            // Granted caps are the intersection of what was granted and what the
            // manifest currently declares (a plugin update can't silently widen).
            grantedCaps: pluginHost.validCaps(st.grantedCaps || []).filter((c) => manifest.capabilities.includes(c)),
            source: st.source || 'local',
            tools: [],
            commands: [],
            hooks: [],
            loadError: null,
            error: null,
        };

        // Tools
        for (const file of this._listContribFiles(plugin, 'tools')) {
            const mod = this.requireModule(file);
            if (!mod || !mod.schema || !mod.schema.name || typeof mod.run !== 'function') {
                throw new Error(`tool ${this.path.basename(file)} must export { schema:{name,...}, run() }`);
            }
            plugin.tools.push({ name: mod.schema.name, schema: mod.schema, run: mod.run, file });
        }
        // Commands
        for (const file of this._listContribFiles(plugin, 'commands')) {
            const mod = this.requireModule(file);
            if (!mod || !mod.name || (typeof mod.prompt !== 'string' && typeof mod.run !== 'function')) {
                throw new Error(`command ${this.path.basename(file)} must export { name, prompt|run }`);
            }
            plugin.commands.push({ name: mod.name, description: mod.description || '', prompt: mod.prompt, run: mod.run, file });
        }
        // Hooks
        for (const file of this._listContribFiles(plugin, 'hooks')) {
            const mod = this.requireModule(file);
            if (!mod || !HOOK_EVENTS.includes(mod.event) || typeof mod.run !== 'function') {
                throw new Error(`hook ${this.path.basename(file)} must export { event:<one of ${HOOK_EVENTS.join('|')}>, run() }`);
            }
            plugin.hooks.push({ event: mod.event, run: mod.run, file });
        }

        this.registry.set(manifest.id, plugin);
        return plugin;
    }

    /** Disable+flag any enabled plugin whose tool name collides with a core tool or another enabled plugin. */
    _resolveToolCollisions() {
        // Reset to the load error (if any); collision errors are recomputed below.
        for (const plugin of this.registry.values()) plugin.error = plugin.loadError || null;
        const claimed = new Map(); // toolName -> pluginId
        for (const plugin of this.registry.values()) {
            if (!plugin.enabled || plugin.error) continue;
            for (const t of plugin.tools) {
                if (this.coreToolNames.has(t.name)) {
                    plugin.error = `tool "${t.name}" collides with a core tool`;
                    break;
                }
                if (claimed.has(t.name)) {
                    plugin.error = `tool "${t.name}" already provided by plugin "${claimed.get(t.name)}"`;
                    break;
                }
            }
            if (plugin.error) continue;
            for (const t of plugin.tools) claimed.set(t.name, plugin.manifest.id);
        }
    }

    // ---- queries -----------------------------------------------------------

    list() {
        return Array.from(this.registry.values()).map((p) => ({
            id: p.manifest.id,
            name: p.manifest.name,
            version: p.manifest.version,
            description: p.manifest.description,
            author: p.manifest.author,
            capabilities: p.manifest.capabilities,
            grantedCaps: p.grantedCaps,
            enabled: p.enabled,
            source: p.source,
            error: p.error,
            tools: p.tools.map((t) => t.name),
            commands: p.commands.map((c) => ({ name: c.name, description: c.description })),
            hooks: p.hooks.map((h) => h.event),
        }));
    }

    /** OpenAI-format tool schemas for every enabled, error-free plugin tool. */
    getEnabledToolSchemas() {
        const out = [];
        for (const plugin of this.registry.values()) {
            if (!plugin.enabled || plugin.error) continue;
            for (const t of plugin.tools) {
                out.push({ type: 'function', function: t.schema });
            }
        }
        return out;
    }

    getEnabledCommands() {
        const out = [];
        for (const plugin of this.registry.values()) {
            if (!plugin.enabled || plugin.error) continue;
            for (const c of plugin.commands) {
                out.push({ pluginId: plugin.manifest.id, name: c.name, description: c.description });
            }
        }
        return out;
    }

    _findToolOwner(toolName) {
        for (const plugin of this.registry.values()) {
            if (!plugin.enabled || plugin.error) continue;
            const t = plugin.tools.find((x) => x.name === toolName);
            if (t) return { plugin, tool: t };
        }
        return null;
    }

    isPluginTool(toolName) {
        return !!this._findToolOwner(toolName);
    }

    // ---- host construction -------------------------------------------------

    _buildHost(plugin) {
        const pc = this.projectContext;
        const fsmod = this.fs;
        const fsImpl = pc ? {
            readFile: (p) => { const r = pc.resolvePath(p); if (r.error) throw new Error(r.error); return fsmod.readFileSync(r.path, 'utf8'); },
            writeFile: (p, c) => { const r = pc.resolvePath(p); if (r.error) throw new Error(r.error); fsmod.writeFileSync(r.path, c); return r.path; },
            exists: (p) => { const r = pc.resolvePath(p); if (r.error) return false; return fsmod.existsSync(r.path); },
            list: (p) => { const r = pc.resolvePath(p); if (r.error) throw new Error(r.error); return fsmod.readdirSync(r.path); },
        } : null;

        const guard = this.netGuard;
        const fetchImpl = this.fetchImpl;
        const netFetch = (fetchImpl) ? (url, opts) => {
            if (guard && !guard.validatePublicFetchTarget(url)) {
                // Reject (don't throw synchronously) so the fetch-like API is uniform.
                return Promise.reject(new Error(`net target blocked by netGuard: ${url}`));
            }
            return fetchImpl(url, opts);
        } : null;

        return pluginHost.build(plugin.grantedCaps, {
            pluginId: plugin.manifest.id,
            log: (id, msg) => this.log(`[${id}] ${msg}`),
            fs: fsImpl,
            runCommand: this.runCommand,
            netFetch,
            memory: this.memory,
            uiNotify: this.uiNotify,
        });
    }

    // ---- invocation --------------------------------------------------------

    async invokeTool(toolName, args) {
        const found = this._findToolOwner(toolName);
        if (!found) return `Error: no enabled plugin provides tool "${toolName}".`;
        const host = this._buildHost(found.plugin);
        try {
            const result = await found.tool.run(args || {}, host);
            if (result == null) return 'Success';
            return typeof result === 'string' ? result : JSON.stringify(result);
        } catch (e) {
            return `Error in plugin "${found.plugin.manifest.id}" tool "${toolName}": ${e.message || e}`;
        }
    }

    async runCommandText(name, argText) {
        for (const plugin of this.registry.values()) {
            if (!plugin.enabled || plugin.error) continue;
            const cmd = plugin.commands.find((c) => c.name === name);
            if (!cmd) continue;
            if (typeof cmd.run === 'function') {
                const host = this._buildHost(plugin);
                return await cmd.run(argText || '', host);
            }
            return String(cmd.prompt || '').replace(/\{\{\s*args\s*\}\}/g, argText || '');
        }
        return null;
    }

    /** Fire all hooks for an event. before* hooks may return {block,reason}. */
    async fireHook(event, payload) {
        let result = { blocked: false };
        for (const plugin of this.registry.values()) {
            if (!plugin.enabled || plugin.error) continue;
            for (const h of plugin.hooks) {
                if (h.event !== event) continue;
                try {
                    const host = this._buildHost(plugin);
                    const r = await h.run(payload, host);
                    if (event.startsWith('before') && r && r.block) {
                        result = { blocked: true, reason: r.reason || `blocked by plugin ${plugin.manifest.id}`, by: plugin.manifest.id };
                        return result; // first veto wins
                    }
                } catch (e) {
                    this.log(`hook ${event} in ${plugin.manifest.id} failed: ${e.message}`); // swallow
                }
            }
        }
        return result;
    }

    // ---- mutation ----------------------------------------------------------

    setEnabled(id, enabled, grantedCaps) {
        const plugin = this.registry.get(id);
        if (!plugin) return { error: `unknown plugin ${id}` };
        const caps = grantedCaps != null
            ? pluginHost.validCaps(grantedCaps).filter((c) => plugin.manifest.capabilities.includes(c))
            : plugin.grantedCaps;
        plugin.enabled = !!enabled;
        plugin.grantedCaps = caps;
        this.state[id] = {
            ...(this.state[id] || {}),
            enabled: !!enabled,
            grantedCaps: caps,
            version: plugin.manifest.version,
        };
        this.saveState();
        // A change in enablement can introduce/clear collisions.
        this._resolveToolCollisions();
        return { success: true, plugin: this.list().find((p) => p.id === id) };
    }

    uninstall(id) {
        const plugin = this.registry.get(id);
        if (!plugin) return { error: `unknown plugin ${id}` };
        try {
            this.fs.rmSync(plugin.dir, { recursive: true, force: true });
        } catch (e) {
            return { error: `failed to remove ${id}: ${e.message}` };
        }
        delete this.state[id];
        this.saveState();
        this.registry.delete(id);
        return { success: true };
    }
}

module.exports = PluginManager;
module.exports.HOOK_EVENTS = HOOK_EVENTS;
