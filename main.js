const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const { spawn, exec, execSync } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// Resource Monitoring System
let resourceMonitorInterval = null;
function startResourceMonitor(win) {
    if (resourceMonitorInterval) clearInterval(resourceMonitorInterval);
    
    resourceMonitorInterval = setInterval(async () => {
        if (!win || win.isDestroyed()) return;
        
        try {
            const memoryInfo = await process.getProcessMemoryInfo();
            const systemMem = os.freemem();
            const totalMem = os.totalmem();
            const freePercent = (systemMem / totalMem) * 100;
            
            // RSS (Resident Set Size) is the actual RAM used by the process
            const rssMB = memoryInfo.residentSet / 1024 / 1024;
            
            let status = 'healthy';
            if (freePercent < 15 || rssMB > 1500) {
                status = 'congested';
            } else if (freePercent < 30 || rssMB > 1000) {
                status = 'warning';
            }
            
            if (status !== 'healthy') {
                console.log(`[RESOURCE MONITOR] Status: ${status} (Free RAM: ${freePercent.toFixed(1)}%, Process: ${rssMB.toFixed(0)}MB)`);
                win.webContents.send('resource-update', {
                    status,
                    freePercent,
                    rssMB,
                    timestamp: Date.now()
                });
            }
        } catch (e) {
            console.error('Resource monitor error:', e);
        }
    }, 5000); // Check every 5 seconds
}

// Hardware Optimizations & Crash Prevention
function applyHardwareOptimizations() {
    let vendor = 'GENERIC';
    try {
        let isNVIDIA = false;
        let isAMD = false;

        // Detect GPU synchronously via lspci
        try {
            const lspciOut = execSync('lspci | grep -i "3d\\|display\\|vga"', { encoding: 'utf8' }).toLowerCase();
            isNVIDIA = lspciOut.includes('nvidia');
            isAMD = lspciOut.includes('amd') || lspciOut.includes('radeon');
            
            if (isAMD) {
                console.log(`Hardware: AMD GPU Detected.`);
                vendor = 'AMD';
                if (lspciOut.includes('strix') || lspciOut.includes('880m') || lspciOut.includes('890m')) {
                    console.log('Hardware: Applying HSA_OVERRIDE_GFX_VERSION=11.0.0 for Strix Point compatibility.');
                    process.env.HSA_OVERRIDE_GFX_VERSION = '11.0.0';
                }
            }
            if (isNVIDIA) {
                console.log(`Hardware: NVIDIA GPU Detected.`);
                vendor = 'NVIDIA';
            }
        } catch (e) {
            console.warn('Could not detect GPU via lspci');
        }

        // Apply OS-level GPU fixes to prevent Electron crashes
        if (process.platform === 'linux' || process.platform === 'win32') {
            app.commandLine.appendSwitch('disable-gpu-sandbox');
            app.commandLine.appendSwitch('ignore-gpu-blocklist');
            app.commandLine.appendSwitch('disable-dev-shm-usage');
            app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
        }

        if (process.platform === 'linux') {
            app.commandLine.appendSwitch('disable-gpu-rasterization');
            app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
            app.commandLine.appendSwitch('disable-accelerated-video-decode');
            app.commandLine.appendSwitch('disable-zero-copy');
        }

        // Optimize threading based on CPU
        const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8').toLowerCase();
        if (cpuInfo.includes('authenticamd')) {
            console.log('Hardware: AMD CPU Detected. Optimizing threads.');
            const cores = require('os').cpus();
            const physicalCores = cores.length > 4 ? cores.length / 2 : cores.length;
            process.env.OMP_NUM_THREADS = Math.floor(physicalCores).toString();
        }

        // Prevent network service crashes on Linux Wayland/XWayland with AMD by disabling buggy rasterization flags
        if (process.platform === 'linux' && isAMD) {
            app.commandLine.appendSwitch('disable-gpu-rasterization');
            app.commandLine.appendSwitch('disable-zero-copy');
        }

    } catch (e) {
        console.warn('Hardware detection notice:', e.message);
    }
    return vendor;
}
const gpuVendor = applyHardwareOptimizations();

// (force_high_performance_gpu removed to prevent GPU crashes on some Linux configs)

if (process.env.XKALIBER_NO_GPU === '1') {
    app.disableHardwareAcceleration();
}

// Clear GPU Cache on startup to prevent NVIDIA corruption issues
const initUserDataPath = app.getPath('userData');
const gpuCachePath = path.join(initUserDataPath, 'GPUCache');
try {
    if (fs.existsSync(gpuCachePath)) {
        fs.rmSync(gpuCachePath, { recursive: true, force: true });
        console.log('Cleared GPUCache to prevent NVIDIA driver issues.');
    }
} catch (err) {
    console.error('Failed to clear GPUCache:', err);
}

// WhatsApp Client Setup
let whatsappClient = null;

// Wrap ipcMain.handle to save a copy for the web UI
const originalHandle = ipcMain.handle.bind(ipcMain);
const webHandlers = new Map();
ipcMain.handle = (channel, listener) => {
    webHandlers.set(channel, listener);
    return originalHandle(channel, listener);
};

// ... existing code ...

ipcMain.handle('whatsapp-init', async (event) => {
    if (whatsappClient) return { status: 'already_init' };

    whatsappClient = new Client({
        authStrategy: new LocalAuth({ dataPath: path.join(app.getPath('userData'), 'wa_auth') }),
        puppeteer: {
            handleSIGINT: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    whatsappClient.on('qr', async (qr) => {
        const qrImage = await qrcode.toDataURL(qr);
        if (mainWindow) mainWindow.webContents.send('whatsapp-qr', qrImage);
    });

    whatsappClient.on('ready', () => {
        if (mainWindow) mainWindow.webContents.send('whatsapp-ready');
        console.log('WhatsApp is ready!');
    });

    whatsappClient.on('authenticated', () => {
        console.log('WhatsApp Authenticated');
    });

    whatsappClient.on('auth_failure', (msg) => {
        if (mainWindow) mainWindow.webContents.send('whatsapp-error', msg);
    });

    whatsappClient.on('disconnected', () => {
        if (mainWindow) mainWindow.webContents.send('whatsapp-disconnected');
        whatsappClient = null;
    });

    try {
        await whatsappClient.initialize();
        return { success: true };
    } catch (err) {
        return { error: err.message };
    }
});

ipcMain.handle('whatsapp-send', async (event, { number, message }) => {
    if (!whatsappClient) return { error: 'WhatsApp not initialized' };
    try {
        const sanitizedNum = number.includes('@') ? number : `${number.replace(/\D/g, '')}@c.us`;
        await whatsappClient.sendMessage(sanitizedNum, message);
        return { success: true };
    } catch (err) {
        return { error: err.message };
    }
});

// File Attachment Handler
ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        title: 'Select File to Attach'
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        try {
            const stats = await fsPromises.stat(filePath);
            const fileName = path.basename(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
            const isImage = imageExts.includes(ext);

            if (isImage) {
                if (stats.size > 50 * 1024 * 1024) {
                    return { error: 'Image file is too large (over 50MB limit).' };
                }
                const fileBuffer = await fsPromises.readFile(filePath);
                const base64 = fileBuffer.toString('base64');
                return { filePath, fileName, isImage: true, base64, size: stats.size };
            } else {
                let content;
                if (stats.size < 1024 * 1024) {
                    content = await fsPromises.readFile(filePath, 'utf-8');
                } else {
                    content = `[FILE TOO LARGE TO AUTO-READ: ${stats.size} bytes. Use read_file tool to access specific parts.]`;
                }
                return { filePath, fileName, isImage: false, content, size: stats.size };
            }
        } catch (err) {
            return { error: err.message };
        }
    }
    return null;
});

// Persistent Session Memory Paths
const userDataPath = app.getPath('userData');
const AuthManager = require('./auth.js');
const authManager = new AuthManager(userDataPath);

ipcMain.handle('auth-login', async (event, { username, password }) => {
    try {
        const token = await authManager.login(username, password);
        return { success: true, token };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('auth-register', async (event, { username, password }) => {
    try {
        await authManager.register(username, password);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('auth-check', async (event, token) => {
    const user = authManager.verifyToken(token);
    if (!user) return { authenticated: false };
    return { authenticated: true, user };
});

ipcMain.handle('auth-get-users', async (event, token) => {
    const user = authManager.verifyToken(token);
    if (!user || user.role !== 'admin') return { error: 'Unauthorized' };
    try {
        return { success: true, users: authManager.getAllUsers(user.username) };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('auth-update-user', async (event, { token, targetUsername, permissions }) => {
    const user = authManager.verifyToken(token);
    if (!user || user.role !== 'admin') return { error: 'Unauthorized' };
    try {
        authManager.updateUserPermissions(user.username, targetUsername, permissions);
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('auth-logout', async (event, token) => {
    authManager.logout(token);
    return { success: true };
});

ipcMain.handle('auth-has-users', async () => {
    return { hasUsers: authManager.hasUsers() };
});

const historyFile = path.join(userDataPath, 'xkaliber_agent_session_v38_5.json');
const legacyFiles = [
    'xkaliber_agent_session_v38_4.json',
    'xkaliber_agent_session_v38_3.json',
    'xkaliber_agent_session_v37_9_1.json',
    'xkaliber_agent_session_v37.json',
    'xkaliber_agent_session_v36.json',
    'xkaliber_agent_session_v35.json',
    'xkaliber_agent_session_v34.json',
    'xkaliber_agent_session_v33.json',
    'xkaliber_agent_session_v32.json',
    'xkaliber_agent_session_v30.json',
    'xkaliber_agent_session_v29.json',
    'xkaliber_agent_session.json'
];

ipcMain.handle('load-history', async () => {
    try {
        if (fs.existsSync(historyFile)) {
            const data = await fsPromises.readFile(historyFile, 'utf-8');
            return JSON.parse(data);
        } else {
            // Find the largest/most viable legacy history file to migrate
            // since v34 may have been wiped by the Task Isolation bug
            let bestLegacyFile = null;
            let maxSize = 0;
            
            for (const lf of legacyFiles) {
                const lfPath = path.join(userDataPath, lf);
                if (fs.existsSync(lfPath)) {
                    const stats = await fsPromises.stat(lfPath);
                    // If it's over 1KB, it's likely a real history file, not a wiped one
                    if (stats.size > maxSize && stats.size > 1024) {
                        maxSize = stats.size;
                        bestLegacyFile = lfPath;
                    }
                }
            }

            if (bestLegacyFile) {
            console.log(`Migrating history from ${bestLegacyFile} to v40.7...`);
            const data = await fsPromises.readFile(bestLegacyFile, 'utf-8');
             const history = JSON.parse(data);
             await fsPromises.writeFile(historyFile, JSON.stringify(history), 'utf-8');
             return history;
            }        }
    } catch (e) {
        console.error('Failed to load history', e);
    }
    return [];
});

ipcMain.handle('save-history', async (event, history) => {
    try {
        await fsPromises.writeFile(historyFile, JSON.stringify(history), 'utf-8');
        return true;
    } catch (e) {
        console.error('Failed to save history', e);
        return false;
    }
});

ipcMain.handle('clear-history', async () => {
    try {
        if (fs.existsSync(historyFile)) {
            await fsPromises.unlink(historyFile);
        }
        return true;
    } catch (e) {
        return false;
    }
});

// Session Export/Import
ipcMain.handle('export-session', async (event, data) => {
    const result = await dialog.showSaveDialog({
        title: 'Export Session',
        defaultPath: `xkaliber-session-${Date.now()}.json`,
        filters: [
            { name: 'JSON', extensions: ['json'] },
            { name: 'Markdown', extensions: ['md'] }
        ]
    });
    if (result.canceled || !result.filePath) return null;

    const ext = path.extname(result.filePath).toLowerCase();
    if (ext === '.md') {
        let md = `# Xkaliber Agent Session\n\nExported: ${new Date().toISOString()}\n\n---\n\n`;
        for (const msg of data) {
            if (msg.role === 'user') md += `## User\n\n${msg.content}\n\n`;
            else if (msg.role === 'assistant' && msg.content) md += `## Assistant\n\n${msg.content}\n\n`;
            else if (msg.role === 'system') md += `> **System:** ${msg.content}\n\n`;
        }
        await fsPromises.writeFile(result.filePath, md, 'utf-8');
    } else {
        await fsPromises.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
    }
    return { success: true, filePath: result.filePath };
});

ipcMain.handle('import-session', async () => {
    const result = await dialog.showOpenDialog({
        title: 'Import Session',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    try {
        const data = await fsPromises.readFile(result.filePaths[0], 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
        title: 'Select Workspace Directory',
        properties: ['openDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
        return { path: result.filePaths[0] };
    }
    return null;
});

// Agent Harness IPC Handlers
const projectContext = require('./projectContext.js');
const ChangeLedger = require('./changeLedger.js');
const EditEngine = require('./editEngine.js');
const PlanStore = require('./planStore.js');

const changeLedger = new ChangeLedger(userDataPath);
const planStore = new PlanStore(userDataPath, projectContext);
const editEngine = new EditEngine(changeLedger, projectContext);

const activeProcesses = new Map();
let nextJobId = 1;
let currentPlanId = null;

function relPathFromRoot(absPath) {
    const root = projectContext.getRoot();
    return path.relative(root, absPath).replace(/\\/g, '/');
}

function spawnShell(command, cwd, isBackground) {
    const cfg = projectContext.getShellConfig();
    if (projectContext.isWindows()) {
        const args = [cfg.flag, cfg.commandFlag, command];
        return spawn(cfg.shell, args, { cwd, shell: false });
    }
    if (isBackground) {
        return spawn(cfg.shell, [cfg.flag, command], { cwd });
    }
    return null;
}

ipcMain.handle('agent-run-command', async (event, command, isBackground, planId) => {
    const pid = planId || currentPlanId;
    const cwd = projectContext.getRoot();

    if (isBackground) {
        const jobId = nextJobId++;
        const child = spawnShell(command, cwd, true);
        if (!child) {
            return { error: 'Failed to spawn background process' };
        }
        const procInfo = { process: child, log: [], command, exitCode: null, running: true, startedAt: Date.now() };
        activeProcesses.set(jobId, procInfo);

        const appendLog = (data) => {
            const text = data.toString();
            const lines = text.split('\n');
            if (lines[lines.length - 1] === '') lines.pop();
            procInfo.log.push(...lines);
            if (procInfo.log.length > 2000) procInfo.log = procInfo.log.slice(-2000);
        };

        child.stdout.on('data', appendLog);
        child.stderr.on('data', appendLog);
        child.on('close', (code) => {
            procInfo.log.push(`[Process exited with code ${code}]`);
            procInfo.exitCode = code;
            procInfo.running = false;
        });

        return { stdout: `Process started in background. Job ID: ${jobId}. Use read_process_log to check status, stop_process to kill it.` };
    }

    return new Promise((resolve) => {
        // Foreground timeout so a command the model forgot to background (e.g. a dev
        // server) fails fast instead of hanging the whole turn. Long builds should use
        // is_background:true.
        const FG_TIMEOUT_MS = 300000;
        const onDone = (error, stdout, stderr) => {
            if (error && error.killed) {
                resolve({ error: `Command timed out after ${FG_TIMEOUT_MS / 1000}s and was killed. For long-running tasks (servers, watchers), call run_shell_command with is_background:true.`, stdout, stderr });
            } else {
                resolve({ error: error ? error.message : null, stdout, stderr });
            }
        };
        const execOpts = { cwd, maxBuffer: 1024 * 1024 * 50, timeout: FG_TIMEOUT_MS, killSignal: 'SIGKILL' };
        if (projectContext.isWindows()) {
            exec(`powershell.exe -NoProfile -Command ${JSON.stringify(command)}`, execOpts, onDone);
        } else {
            exec(command, execOpts, onDone);
        }
    });
});

ipcMain.handle('agent-stop-process', async (event, jobId) => {
    const procInfo = activeProcesses.get(parseInt(jobId, 10));
    if (!procInfo) return { error: `No active job found with ID: ${jobId}` };
    try {
        procInfo.process.kill('SIGKILL');
        procInfo.running = false;
        return { success: true, stdout: `Job ${jobId} killed.` };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('agent-list-processes', async () => {
    const jobs = [];
    for (const [jobId, info] of activeProcesses) {
        jobs.push({
            jobId,
            running: info.running !== false && info.exitCode === null,
            exitCode: info.exitCode,
            command: info.command || '',
            lastLine: info.log.length ? info.log[info.log.length - 1] : ''
        });
    }
    return { jobs };
});

ipcMain.handle('agent-read-process-log', async (event, jobId, lines = 50) => {
    const procInfo = activeProcesses.get(parseInt(jobId, 10));
    if (!procInfo) return { error: `No active job found with ID: ${jobId}` };
    const logSlice = procInfo.log.slice(-lines).join('\n');
    return {
        log: logSlice || "(No output yet)",
        running: procInfo.running !== false && procInfo.exitCode === null,
        exitCode: procInfo.exitCode
    };
});

ipcMain.handle('agent-send-input', async (event, jobId, input) => {
    const procInfo = activeProcesses.get(parseInt(jobId, 10));
    if (!procInfo) return { error: `No active job found with ID: ${jobId}` };
    if (procInfo.process.exitCode !== null) return { error: `Process already exited.` };
    try {
        procInfo.process.stdin.write(input + (input.endsWith('\n') ? '' : '\n'));
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('agent-read-file', async (event, filepath, startLine, endLine) => {
    try {
        const resolved = projectContext.resolvePath(filepath, { allowOutsideBeforeRoot: !projectContext.getRootOrNull() });
        if (resolved.error) return { error: resolved.error };
        projectContext.establishFromFilePath(resolved.path);
        let content = await fsPromises.readFile(resolved.path, 'utf-8');
        if (startLine != null || endLine != null) {
            const lines = content.split('\n');
            const start = Math.max(1, parseInt(startLine, 10) || 1) - 1;
            const end = endLine != null ? Math.min(lines.length, parseInt(endLine, 10)) : lines.length;
            content = lines.slice(start, end).join('\n');
            return { content, lineRange: [start + 1, end] };
        }
        return { content };
    } catch (error) {
        return { error: error.message };
    }
});

ipcMain.handle('agent-write-file', async (event, filepath, content, planId) => {
    try {
        const pid = planId || currentPlanId;
        const sizeCheck = editEngine.validateWriteSize(content);
        if (sizeCheck.error) return sizeCheck;

        const resolved = projectContext.resolvePath(filepath, { allowOutsideBeforeRoot: !projectContext.getRootOrNull() });
        if (resolved.error) return { error: resolved.error };

        const absPath = resolved.path;
        const existed = fs.existsSync(absPath);
        if (pid) {
            if (existed) await changeLedger.snapshotBefore(pid, absPath, 'write');
            else await changeLedger.recordCreate(pid, absPath);
        }
        await fsPromises.mkdir(path.dirname(absPath), { recursive: true });
        await fsPromises.writeFile(absPath, content, 'utf-8');
        projectContext.establishFromFilePath(absPath);
        invalidateRepoMap(); // the tree/symbols changed — drop the cached repo map
        return { success: true, path: relPathFromRoot(absPath), created: !existed };
    } catch (error) {
        return { error: error.message };
    }
});

ipcMain.handle('agent-delete-file', async (event, filepath, planId) => {
    try {
        const pid = planId || currentPlanId;
        const resolved = projectContext.resolvePath(filepath);
        if (resolved.error) return { error: resolved.error };
        const absPath = resolved.path;
        if (pid) await changeLedger.snapshotBefore(pid, absPath, 'delete');
        const stats = await fsPromises.stat(absPath);
        if (stats.isDirectory()) {
            await fsPromises.rm(absPath, { recursive: true, force: true });
        } else {
            await fsPromises.unlink(absPath);
        }
        invalidateRepoMap();
        return { success: true };
    } catch (error) {
        return { error: error.message };
    }
});

ipcMain.handle('agent-list-directory', async (event, dirpath) => {
    try {
        const target = dirpath || '.';
        const resolved = projectContext.resolvePath(target, { allowOutsideBeforeRoot: !projectContext.getRootOrNull() });
        if (resolved.error) return { error: resolved.error };
        const files = await fsPromises.readdir(resolved.path, { withFileTypes: true });
        const list = files.map(f => `${f.isDirectory() ? '[DIR] ' : '[FILE]'} ${f.name}`);
        return { files: list.join('\n') };
    } catch (error) {
        return { error: error.message };
    }
});

ipcMain.handle('agent-list-project', async () => {
    try {
        const listing = await projectContext.listProjectTree(2);
        return { listing, projectRoot: projectContext.getRoot() };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('edit-apply', async (event, { planId, filepath, find, replace }) => {
    const pid = planId || currentPlanId;
    if (!pid) return { error: 'No active plan for edit' };
    const result = await editEngine.apply(pid, filepath, find, replace);
    if (result.success) {
        invalidateRepoMap();
        result.relPath = relPathFromRoot(result.path);
        if (planStore) {
            try {
                const plan = await planStore.load(pid);
                if (!plan.error) {
                    planStore.recordFileTouch(plan, result.relPath, 'edit');
                    if (plan.projectRoot !== projectContext.getRootOrNull()) {
                        plan.projectRoot = projectContext.getRootOrNull();
                    }
                    await planStore.save(plan);
                }
            } catch (e) { /* non-fatal */ }
        }
    }
    return result;
});

ipcMain.handle('project-get-root', async () => ({ projectRoot: projectContext.getRootOrNull() || projectContext.getRoot() }));

ipcMain.handle('project-set-root', async (event, rootPath) => {
    const result = projectContext.setRoot(rootPath);
    return result;
});

ipcMain.handle('project-resolve-path', async (event, inputPath) => projectContext.resolvePath(inputPath));

ipcMain.handle('plan-load', async (event, planId) => {
    const plan = await planStore.load(planId);
    if (!plan.error) currentPlanId = plan.id;
    return plan;
});

ipcMain.handle('plan-save', async (event, plan) => {
    if (plan.projectRoot) projectContext.setRoot(plan.projectRoot);
    currentPlanId = plan.id;
    return await planStore.save(plan);
});

ipcMain.handle('plan-list-active', async () => planStore.listActive());

ipcMain.handle('plan-approve', async (event, planId) => {
    const plan = await planStore.load(planId);
    if (plan.error) return plan;
    planStore.approve(plan);
    await planStore.save(plan);
    return { success: true, plan };
});

ipcMain.handle('plan-add-steps', async (event, { planId, steps }) => {
    const plan = await planStore.load(planId || currentPlanId);
    if (plan.error) return plan;
    const added = planStore.addSteps(plan, steps || []);
    await planStore.save(plan);
    return { success: true, plan, added: added.map(s => ({ id: s.id, title: s.title })) };
});

ipcMain.handle('agent-fetch-url', async (event, url) => {
    const u = netGuard.validatePublicFetchTarget(url);
    if (!u) return { error: 'URL rejected (must be http(s) to a non-internal host).' };
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 20000);
        const resp = await fetch(u.toString(), { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'XkaliberAgent/1.0' } });
        clearTimeout(t);
        if (!resp.ok) return { error: `HTTP ${resp.status}`, status: resp.status };
        const ctype = resp.headers.get('content-type') || '';
        let body = await resp.text();
        if (/html/i.test(ctype) || /^\s*</.test(body)) {
            body = body
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                .replace(/[ \t]+/g, ' ')
                .replace(/\n\s*\n\s*\n+/g, '\n\n')
                .trim();
        }
        const MAX = 8000;
        const truncated = body.length > MAX;
        return { content: truncated ? body.slice(0, MAX) + '\n...[truncated — fetch a more specific URL for the rest]' : body, url: u.toString(), status: resp.status, truncated };
    } catch (e) {
        return { error: (e && e.name === 'AbortError') ? 'Fetch timed out (20s).' : (e.message || String(e)) };
    }
});

ipcMain.handle('ledger-diff', async (event, planId) => changeLedger.diff(planId || currentPlanId));

ipcMain.handle('ledger-revert-all', async (event, planId) => changeLedger.revertAll(planId || currentPlanId));

const { grepProject, hasRipgrep } = require('./lib/grepTool.js');
const { globFiles } = require('./lib/globTool.js');
const { buildRepoMap, invalidate: invalidateRepoMap } = require('./lib/repoMap.js');
const activeFileSet = require('./lib/activeFileSet.js');
const projectDetector = require('./lib/projectDetector.js');
const verificationHarness = require('./lib/verificationHarness.js');
const gitIntegration = require('./lib/gitIntegration.js');
const { stepsForType } = require('./lib/planTemplates.js');

ipcMain.handle('agent-grep', async (event, { pattern, path: subpath, glob, case_insensitive }) => {
    try {
        const root = projectContext.getRoot();
        return await grepProject(root, pattern, { subpath, glob, caseInsensitive: case_insensitive });
    } catch (e) {
        return { error: e.message, hits: [] };
    }
});

ipcMain.handle('agent-glob', async (event, { pattern, path: subpath }) => {
    try {
        const root = projectContext.getRoot();
        return await globFiles(root, pattern || '**/*', { subpath });
    } catch (e) {
        return { error: e.message, files: [] };
    }
});

ipcMain.handle('agent-get-repo-map', async (event, { boostTerms, maxTokens }) => {
    try {
        const root = projectContext.getRoot();
        const map = buildRepoMap(root, { boostTerms: boostTerms || [], maxTokens: maxTokens || 1500 });
        return { map, projectRoot: root };
    } catch (e) {
        return { error: e.message, map: '' };
    }
});

ipcMain.handle('agent-verify', async (event, planId, opts = {}) => {
    const pid = planId || currentPlanId;
    if (!pid) return { error: 'No active plan' };
    const plan = await planStore.load(pid);
    if (plan.error) return plan;
    const root = plan.projectRoot || projectContext.getRoot();
    // Forward per-call options (e.g. { syntaxOnly:true } for intermediate steps) so
    // mid-build steps run only the cheap syntax check instead of the full test suite
    // against half-finished code — otherwise every intermediate mark_step_done fails.
    const result = await verificationHarness.runVerification(root, plan, opts || {});
    // Only stamp [verified] when a real check actually passed — never when the result
    // was merely "unverified" (nothing could be checked). This stops the false-green.
    if (result.ok && !result.unverified && plan.currentStepId) {
        verificationHarness.markStepVerified(plan, plan.currentStepId);
        await planStore.save(plan);
    }
    return { ...result, plan };
});

ipcMain.handle('agent-doctor', async () => ({
    hasRipgrep: hasRipgrep(),
    projectRoot: projectContext.getRootOrNull(),
    planId: currentPlanId
}));

ipcMain.handle('edit-apply-patch', async (event, { planId, filepath, patch }) => {
    const pid = planId || currentPlanId;
    if (!pid) return { error: 'No active plan' };
    const result = await editEngine.applyPatch(pid, filepath, patch);
    if (result.success) {
        invalidateRepoMap();
        result.relPath = relPathFromRoot(result.path);
        const plan = await planStore.load(pid);
        if (!plan.error) {
            planStore.recordFileTouch(plan, result.relPath, 'edit');
            await planStore.save(plan);
        }
    }
    return result;
});

ipcMain.handle('edit-apply-batch', async (event, { planId, edits }) => {
    const pid = planId || currentPlanId;
    if (!pid) return { error: 'No active plan' };
    const res = await editEngine.applyBatch(pid, edits || []);
    invalidateRepoMap();
    // Attach project-relative paths and record file touches on the plan, mirroring
    // the single-edit 'edit-apply' handler so batch edits are tracked (and revertable).
    if (res.results) {
        let plan = null;
        try { const p = await planStore.load(pid); if (!p.error) plan = p; } catch (e) { plan = null; }
        for (const r of res.results) {
            if (r.result?.success && r.result.path) {
                r.result.relPath = relPathFromRoot(r.result.path);
                if (plan) planStore.recordFileTouch(plan, r.result.relPath, 'edit');
            }
        }
        if (plan) { try { await planStore.save(plan); } catch (e) { /* non-fatal */ } }
    }
    return res;
});

ipcMain.handle('git-init', async (event, planId) => {
    const root = projectContext.getRoot();
    return gitIntegration.init(root);
});

ipcMain.handle('git-status', async () => gitIntegration.status(projectContext.getRoot()));

ipcMain.handle('git-diff', async () => gitIntegration.diff(projectContext.getRoot()));

ipcMain.handle('git-commit', async (event, { message, planId }) => {
    const root = projectContext.getRoot();
    return gitIntegration.commit(root, message || 'Xkaliber agent checkpoint');
});

ipcMain.handle('git-undo', async () => gitIntegration.undoLast(projectContext.getRoot()));

ipcMain.handle('git-log', async (event, n) => gitIntegration.logOneline(projectContext.getRoot(), n || 10));

ipcMain.handle('plan-detect', async () => {
    const root = projectContext.getRootOrNull() || projectContext.getRoot();
    return projectDetector.detect(root);
});

ipcMain.handle('plan-create', async (event, { goal, steps, userText, projectType }) => {
    let stepList = steps;
    if (projectType === 'greenfield' && (!stepList || !stepList.length)) {
        const det = projectDetector.detect(projectContext.getRootOrNull() || process.cwd());
        stepList = stepsForType('greenfield', det.language) || stepsForType('greenfield', 'node');
    }
    const plan = planStore.createEmptyPlan(goal, stepList, userText);
    if (projectType) plan.projectType = projectType;
    const root = plan.projectRoot || projectContext.getRootOrNull();
    if (root) {
        planStore.applyDetector(plan, projectDetector.detect(root));
    }
    activeFileSet.addFiles(plan, activeFileSet.parseMentionsFromText(userText || goal, root), root);
    currentPlanId = plan.id;
    projectContext.setPlanId(plan.id);
    await planStore.save(plan);
    return { success: true, plan };
});

let mainWindow;

// Cross-platform Linux audio player detection
let cachedAudioPlayer = undefined;

function detectAudioPlayer() {
    if (cachedAudioPlayer !== undefined) return cachedAudioPlayer;

    const players = [
        { cmd: 'aplay',  args: ['-r', '22050', '-f', 'S16_LE', '-t', 'raw', '-'] },
        { cmd: 'paplay', args: ['--raw', '--rate=22050', '--channels=1', '--format=s16le'] },
        { cmd: 'ffplay', args: ['-nodisp', '-autoexit', '-f', 's16le', '-ar', '22050', '-ac', '1', '-'] }
    ];

    for (const p of players) {
        try {
            execSync(`which ${p.cmd}`, { stdio: 'ignore' });
            console.log(`TTS: Detected audio player: ${p.cmd}`);
            cachedAudioPlayer = p;
            return p;
        } catch (e) { /* not found, try next */ }
    }

    console.warn('TTS: No audio player found (tried aplay, paplay, ffplay)');
    cachedAudioPlayer = null;
    return null;
}

// Determine paths for Piper TTS and prevent AppImage EACCES by copying to userData
const getPiperPaths = () => {
    let sourceBasePath = path.join(process.resourcesPath, 'piper');
    if (!fs.existsSync(path.join(sourceBasePath, 'piper'))) {
        sourceBasePath = path.join(__dirname, 'resources', 'piper');
    }

    const userDataPiperPath = path.join(app.getPath('userData'), 'piper_env');
    
    // If not copied yet, copy it to bypass read-only AppImage restrictions
    if (!fs.existsSync(path.join(userDataPiperPath, 'piper'))) {
        console.log('TTS: Copying Piper binaries to writable directory to prevent EACCES...');
        try {
            fs.cpSync(sourceBasePath, userDataPiperPath, { recursive: true });
        } catch (err) {
            console.error('TTS Copy Error:', err);
        }
    }

    // Fix potentially broken absolute symlinks from AppImage mounts
    try {
        const libs = [
            { link: 'libespeak-ng.so.1', target: 'libespeak-ng.so.1.52.0.1' },
            { link: 'libonnxruntime.so.1', target: 'libonnxruntime.so.1.14.1' },
            { link: 'libpiper_phonemize.so.1', target: 'libpiper_phonemize.so.1.2.0' }
        ];
        for (const l of libs) {
            const linkPath = path.join(userDataPiperPath, l.link);
            try {
                let shouldCreate = false;
                if (fs.existsSync(linkPath)) {
                    const stats = fs.lstatSync(linkPath);
                    if (stats.isSymbolicLink()) {
                        const currentTarget = fs.readlinkSync(linkPath);
                        if (path.isAbsolute(currentTarget) || !fs.existsSync(linkPath)) {
                            fs.unlinkSync(linkPath);
                            shouldCreate = true;
                        }
                    }
                } else {
                    shouldCreate = true;
                }
                
                if (shouldCreate) {
                    fs.symlinkSync(l.target, linkPath);
                    console.log(`TTS: Fixed symlink ${l.link} -> ${l.target}`);
                }
            } catch (e) {
                console.error(`TTS: Failed to fix symlink ${l.link}:`, e.message);
            }
        }
    } catch (err) {
        console.error('TTS Symlink Fix Error:', err);
    }

    // Enforce execution permissions
    try {
        const executables = ['piper', 'piper_phonemize', 'espeak-ng'];
        for (const exe of executables) {
            const exePath = path.join(userDataPiperPath, exe);
            if (fs.existsSync(exePath)) fs.chmodSync(exePath, 0o755);
        }
    } catch (err) {
        console.error('TTS Chmod Error:', err);
    }

    return { 
        piperExec: path.join(userDataPiperPath, 'piper'), 
        modelFile: path.join(userDataPiperPath, 'en_US-lessac-medium.onnx'), 
        basePath: userDataPiperPath 
    };
};

let currentTTSProcess = null;
let audioPlayerProcess = null;

function killTTS() {
    if (currentTTSProcess) { currentTTSProcess.kill(); currentTTSProcess = null; }
    if (audioPlayerProcess) { audioPlayerProcess.kill(); audioPlayerProcess = null; }
}

function speakText(text) {
    if (!text) return;
    try {
        killTTS();

        const { piperExec, modelFile, basePath } = getPiperPaths();

        if (!fs.existsSync(piperExec)) {
            console.error(`TTS Error: Piper executable not found at ${piperExec}`);
            if (mainWindow) mainWindow.webContents.send('tts-error', `Piper not found at ${piperExec}`);
            return;
        }

        const audioPlayer = detectAudioPlayer();
        if (!audioPlayer) {
            if (mainWindow) mainWindow.webContents.send('tts-error', 'No audio player found. Install aplay, paplay, or ffplay.');
            return;
        }

        console.log(`TTS: Speaking "${text.substring(0, 40)}..." via ${audioPlayer.cmd}`);

        const piper = spawn(piperExec, ['--model', modelFile, '--output_raw'], { 
            cwd: basePath,
            env: { ...process.env, LD_LIBRARY_PATH: basePath }
        });
        const player = spawn(audioPlayer.cmd, audioPlayer.args);

        // Robust stream handling
        if (piper.stdout && player.stdin) {
            piper.stdout.pipe(player.stdin);
            
            piper.stdout.on('error', (e) => console.error('Piper stdout error:', e));
            player.stdin.on('error', (e) => {
                if (e.code === 'EPIPE') {
                    console.warn('TTS: Audio player stdin closed prematurely (EPIPE).');
                } else {
                    console.error('Player stdin error:', e);
                }
            });
        }

        piper.stderr.on('data', (data) => console.error(`Piper stderr: ${data}`));

        piper.on('error', (err) => {
            console.error('Piper process error:', err);
            if (mainWindow) mainWindow.webContents.send('tts-error', `Piper error: ${err.message}`);
        });

        player.on('error', (err) => {
            console.error('Audio player error:', err);
            if (mainWindow) mainWindow.webContents.send('tts-error', `Audio player error: ${err.message}`);
        });

        piper.on('close', (code) => {
            if (code !== 0 && code !== null) console.log(`Piper exited with code ${code}`);
            if (player.stdin && !player.stdin.destroyed) {
                try { player.stdin.end(); } catch (e) {}
            }
        });

        player.on('close', () => {
            if (mainWindow) mainWindow.webContents.send('tts-finished');
        });

        if (piper.stdin) {
            piper.stdin.on('error', (e) => {
                if (e.code === 'EPIPE') {
                    console.warn('TTS: Piper stdin closed prematurely (EPIPE).');
                } else {
                    console.error('Piper stdin error:', e);
                }
            });

            if (!piper.stdin.destroyed) {
                piper.stdin.write(text);
                piper.stdin.end();
            }
        }

        currentTTSProcess = piper;
        audioPlayerProcess = player;
    } catch (globalErr) {
        console.error('TTS Global Error:', globalErr);
        if (mainWindow) mainWindow.webContents.send('tts-error', `Critical TTS Error: ${globalErr.message}`);
    }
}

// Search Handler (Netrunner Mode)
ipcMain.handle('perform-search', async (event, query) => {
    try {
        console.log(`Searching for: ${query}`);
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const response = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://html.duckduckgo.com/'
            }
        });

        if (!response.ok) throw new Error(`Search failed: ${response.statusText}`);

        const html = await response.text();
        const results = [];
        const bodies = html.split('result__body');

        for (let i = 1; i < bodies.length; i++) {
            if (results.length >= 6) break;
            const block = bodies[i];

            const linkMatch = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
            const snippetMatch = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);

            if (linkMatch) {
                let url = linkMatch[1];
                let title = linkMatch[2];
                let snippet = snippetMatch ? snippetMatch[1] : '';

                if (url.startsWith('//duckduckgo.com/l/?uddg=')) {
                    try {
                        const urlObj = new URL('https:' + url);
                        const uddg = urlObj.searchParams.get('uddg');
                        if (uddg) url = decodeURIComponent(uddg);
                    } catch (e) { /* keep original */ }
                }

                const cleanText = (str) => str
                    .replace(/<[^>]+>/g, '')
                    .replace(/&quot;/g, '"')
                    .replace(/&#x27;/g, "'")
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();

                title = cleanText(title);
                snippet = cleanText(snippet);

                if (url && title) results.push({ url, title, snippet });
            }
        }

        return results;
    } catch (error) {
        console.error('Search error:', error);
        return { error: error.message };
    }
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        backgroundColor: '#0d1117',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        },
        autoHideMenuBar: true
    });

    mainWindow.loadFile('index.html');
    startResourceMonitor(mainWindow);
}

app.whenReady().then(() => {
    createWindow();

    ipcMain.on('tts-speak', (event, text) => speakText(text));
    ipcMain.on('tts-stop', () => killTTS());

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// --- VRAM & Crash Detection (v30) ---
let isTelemetryInProgress = false;

ipcMain.handle('get-gpu-telemetry', async () => {
    if (isTelemetryInProgress) return { error: 'Telemetry already in progress' };
    isTelemetryInProgress = true;

    return new Promise((resolve) => {
        // os module is already required at the top
        const systemRam = {
            total: Math.round(os.totalmem() / 1024 / 1024),
            free: Math.round(os.freemem() / 1024 / 1024),
            used: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024)
        };

        const finalize = (data) => {
            isTelemetryInProgress = false;
            resolve(data);
        };

        // Try AMD first (sysfs)
        if (process.platform === 'linux' && fs.existsSync('/sys/class/drm/card0/device/mem_info_vram_total')) {
            try {
                const vramTotal = parseInt(fs.readFileSync('/sys/class/drm/card0/device/mem_info_vram_total', 'utf8')) || 0;
                const vramUsed = parseInt(fs.readFileSync('/sys/class/drm/card0/device/mem_info_vram_used', 'utf8')) || 0;
                let util = 0;
                try { util = parseInt(fs.readFileSync('/sys/class/drm/card0/device/gpu_busy_percent', 'utf8')); } catch(e){}
                
                finalize({
                    vendor: 'AMD',
                    memory: { 
                        total: Math.round(vramTotal / 1024 / 1024), 
                        used: Math.round(vramUsed / 1024 / 1024), 
                        free: Math.round((vramTotal - vramUsed) / 1024 / 1024) 
                    },
                    utilization: util,
                    is_high_pressure: (vramUsed / vramTotal) > 0.95,
                    systemRam
                });
                return;
            } catch (err) {
                console.error("Failed to read AMD sysfs:", err);
            }
        }

        // Fallback to NVIDIA
        exec('nvidia-smi --query-gpu=memory.total,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits', { timeout: 3000 }, (err, stdout) => {
            if (err) {
                finalize({ 
                    error: 'No compatible GPU telemetry found (AMD or NVIDIA)', 
                    details: err.message,
                    systemRam 
                });
                return;
            }
            try {
                const lines = stdout.trim().split('\n');
                const gpus = lines.map(line => {
                    const [total, used, free, util] = line.split(',').map(s => parseInt(s.trim()));
                    return { total, used, free, utilization: util };
                });
                
                const primaryGpu = gpus[0];
                finalize({
                    vendor: 'NVIDIA',
                    memory: { total: primaryGpu.total, used: primaryGpu.used, free: primaryGpu.free },
                    utilization: primaryGpu.utilization,
                    is_high_pressure: (primaryGpu.used / primaryGpu.total) > 0.95,
                    systemRam
                });
            } catch (e) {
                finalize({ error: 'Failed to parse nvidia-smi output', systemRam });
            }
        });
    });
});

ipcMain.handle('app-reset', async (event, { killBackends = false, sudoPass = '' } = {}) => {
    console.log('--- EMERGENCY RESET TRIGGERED ---');
    
    if (killBackends) {
        console.log('Attempting to kill/restart AI backends (Ollama/LM Studio)...');
        
        if (process.platform === 'linux') {
            const sudoCmd = sudoPass ? `echo "${sudoPass}" | sudo -S ` : '';
            try {
                // 1. Graceful SIGTERM first to allow VRAM release (Crucial for AMD/ROCm and NVIDIA)
                exec('pkill -15 -f ollama || true');
                exec('pkill -15 "LM Studio" || true');
                exec('pkill -15 lms || true');
                
                // Wait 2.5 seconds for graceful shutdown and VRAM deallocation
                await new Promise(res => setTimeout(res, 2500));
                
                // 2. Force kill remaining orphans
                exec('pkill -9 -f ollama || true');
                exec('pkill -9 "LM Studio" || true');
                exec('pkill -9 lms || true');

                // Wait 1 second to ensure ports are freed
                await new Promise(res => setTimeout(res, 1000));

                // 3. Attempt to restart Ollama service if we have sudo
                if (sudoCmd) {
                    try {
                        console.log('Restarting Ollama service via systemctl...');
                        execSync(`${sudoCmd} systemctl restart ollama`);
                    } catch(e) {
                        console.log('systemctl restart failed or not applicable.');
                    }
                }
            } catch (e) {
                console.error('Failed to kill backends:', e);
            }
        } else if (process.platform === 'win32') {
            try {
                exec('taskkill /IM ollama.exe /T'); // Try graceful
                exec('taskkill /IM "LM Studio.exe" /T');
                await new Promise(res => setTimeout(res, 2000));
                exec('taskkill /F /IM ollama.exe /T'); // Force
                exec('taskkill /F /IM "LM Studio.exe" /T');
            } catch (e) {}
        }
    }

    setTimeout(() => {
        app.relaunch();
        app.exit(0);
    }, 1000);
    
    return { success: true };
});

// Vector Memory Integration (via memory.js)
const memoryManager = require('./memory.js');
if (typeof gpuVendor !== 'undefined') {
    memoryManager.setGpuVendor(gpuVendor);
}

ipcMain.handle('mem-store', async (event, { text, metadata }) => {
    return await memoryManager.storeVector(text, metadata);
});

ipcMain.handle('mem-query', async (event, { query, limit }) => {
    return await memoryManager.queryVectors(query, limit);
});

ipcMain.handle('mem-count', async () => {
    return { count: memoryManager.getCount() };
});

ipcMain.handle('mem-clear', async () => {
    return memoryManager.clearMemory();
});

// --- Web Hosting (Mobile Access) ---
const http = require('http');
// os module is already required at the top
const WEB_PORT = 3000;

// Host state for LM Studio proxying
let lmsHostUrl = 'http://127.0.0.1:1234';
// Let vector memory fall back to this server's /v1/embeddings when Ollama is absent.
try { memoryManager.setLlmBase(lmsHostUrl); } catch (e) { /* optional */ }

// --- SSRF / download hardening (pure logic in lib/netGuard.js) ---------------
const netGuard = require('./lib/netGuard.js');
const { isBlockedHost } = netGuard;

// Permit a proxy target only if it's loopback or the configured LLM server.
function validateProxyTarget(targetUrl) {
    return netGuard.validateProxyTarget(targetUrl, lmsHostUrl);
}

// Permit a download only for real files inside the project root / app data / downloads.
function validateDownloadPath(rawPath) {
    const roots = [];
    const projRoot = projectContext.getRootOrNull();
    if (projRoot) roots.push(projRoot);
    try { roots.push(app.getPath('userData')); } catch (e) {}
    try { roots.push(app.getPath('downloads')); } catch (e) {}
    return netGuard.validateDownloadPath(rawPath, roots);
}

// --- Plugin system (lib/pluginManager.js + pluginInstaller.js) ---------------
const PluginManager = require('./lib/pluginManager.js');
const PluginInstaller = require('./lib/pluginInstaller.js');

// Core agent tool names plugins may not shadow (kept in sync with PLAN_TOOLS).
const CORE_TOOL_NAMES = [
    'submit_plan', 'mark_step_done', 'mark_step_blocked', 'run_shell_command',
    'run_command', 'read_file', 'write_file', 'edit_file', 'list_directory',
    'list_project', 'delete_file', 'set_project_root', 'memory_search',
    'save_new_user_fact_only', 'read_process_log', 'send_input',
    'provide_file_download_link', 'web_search', 'send_whatsapp_message',
    'dynamic_schema_generate', 'grep_project', 'glob_files', 'get_repo_map',
    'apply_patch', 'apply_edits', 'add_files', 'drop_files', 'run_verify',
    'record_decision', 'init_project'
];

// Foreground command runner for a plugin's `shell` capability (project-root cwd).
function runCommandForPlugin(command) {
    return new Promise((resolve) => {
        const cwd = projectContext.getRoot();
        if (projectContext.isWindows()) {
            exec(`powershell.exe -NoProfile -Command ${JSON.stringify(command)}`, { cwd, maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
                resolve({ error: error ? error.message : null, stdout, stderr });
            });
        } else {
            exec(command, { cwd, maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
                resolve({ error: error ? error.message : null, stdout, stderr });
            });
        }
    });
}

const pluginManager = new PluginManager(userDataPath, {
    projectContext,
    runCommand: runCommandForPlugin,
    memory: {
        store: (text, metadata) => memoryManager.storeVector(text, metadata),
        query: (query, limit) => memoryManager.queryVectors(query, limit),
    },
    uiNotify: (pluginId, msg) => {
        if (mainWindow) mainWindow.webContents.send('plugin-ui-event', { pluginId, message: msg });
    },
    netGuard,
    coreToolNames: CORE_TOOL_NAMES,
});
try { pluginManager.discover(); } catch (e) { console.error('[plugins] discover failed:', e); }

const pluginInstaller = new PluginInstaller(pluginManager.pluginsDir, { netGuard });

ipcMain.handle('plugins-list', async () => pluginManager.list());
ipcMain.handle('plugins-get-contributions', async () => ({
    tools: pluginManager.getEnabledToolSchemas(),
    commands: pluginManager.getEnabledCommands(),
}));
ipcMain.handle('plugin-invoke-tool', async (event, { tool, args }) => {
    const result = await pluginManager.invokeTool(tool, args);
    return { result };
});
ipcMain.handle('plugin-run-command', async (event, { name, argText }) => {
    const text = await pluginManager.runCommandText(name, argText);
    return { text };
});
ipcMain.handle('plugin-fire-hook', async (event, { hookEvent, payload }) =>
    pluginManager.fireHook(hookEvent, payload || {}));
ipcMain.handle('plugin-set-enabled', async (event, { id, enabled, grantedCaps }) =>
    pluginManager.setEnabled(id, enabled, grantedCaps));
ipcMain.handle('plugin-uninstall', async (event, { id }) => pluginManager.uninstall(id));
ipcMain.handle('plugin-install', async (event, { url }) => {
    const res = await pluginInstaller.install(url);
    if (res.success) pluginManager.discover(); // pick up the freshly installed folder
    return res;
});

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

const webServer = http.createServer((req, res) => {
    // CORS Headers for Mobile Web Mode
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-target-url');
    if (req.method === 'OPTIONS') return res.end();

    const url = req.url.split('?')[0];
    const authHeader = req.headers['authorization'];
    const parsedUrlForAuth = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const queryToken = parsedUrlForAuth.searchParams.get('token');
    const token = authHeader ? authHeader.replace('Bearer ', '') : queryToken;
    const user = authManager.verifyToken(token);
    const isAuthenticated = !!user;
    const canUseApp = isAuthenticated && user.permissions.canUseApp;
    const canUseTools = isAuthenticated && user.permissions.canUseTools;

    // Public routes (login/register)
    const isPublicApi = url === '/api/invoke' && req.method === 'POST' && (
        req.headers['x-auth-action'] === 'login' || 
        req.headers['x-auth-action'] === 'register' ||
        req.headers['x-auth-action'] === 'has-users'
    );

    const publicFiles = ['/index.html', '/', '/renderer.js', '/preload.js', '/style.css', '/icon.png'];
    const isPublicFile = publicFiles.includes(url) || url.endsWith('.css') || url.endsWith('.js') || url.endsWith('.png') || url.endsWith('.jpg');

    if (!isAuthenticated && !isPublicApi && !isPublicFile) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    
    if (isAuthenticated && !canUseApp && !isPublicApi && !isPublicFile) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Account pending admin approval' }));
    }

    // API Proxy for Ollama and LM Studio (Solves CORS and localhost binding issues)
    if (url.startsWith('/api/proxy/')) {
        if (!canUseApp) {
            res.writeHead(403); return res.end('Account pending admin approval');
        }
        const targetUrl = req.headers['x-target-url'];
        if (!targetUrl) {
            res.writeHead(400); return res.end('Missing x-target-url header');
        }
        const parsed = validateProxyTarget(targetUrl);
        if (!parsed) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ error: 'Proxy target not allowed. Only the configured local LLM server may be proxied.' }));
        }
        try {
            const transport = parsed.protocol === 'https:' ? require('https') : require('http');
            const options = {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: req.method,
                headers: { ...req.headers, host: parsed.host }
            };

            delete options.headers['origin'];
            delete options.headers['referer'];
            delete options.headers['x-target-url'];
            delete options.headers['accept-encoding'];
            // Don't leak the app's session token / cookies to the proxied target.
            delete options.headers['authorization'];
            delete options.headers['cookie'];
            
            const proxyReq = transport.request(options, (proxyRes) => {
                // Merge target headers with our required CORS headers
                const mergedHeaders = { ...proxyRes.headers };
                mergedHeaders['Access-Control-Allow-Origin'] = '*';
                // Remove some headers that might conflict with the browser's security model
                delete mergedHeaders['content-security-policy'];
                delete mergedHeaders['x-frame-options'];

                res.writeHead(proxyRes.statusCode, mergedHeaders);
                proxyRes.pipe(res);
            });
            
            proxyReq.on('error', e => {
                if (!res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                }
                res.end(JSON.stringify({ error: 'Proxy failed to connect: ' + e.message }));
            });
            
            req.pipe(proxyReq);
        } catch (e) {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            }
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // IPC Proxy for Web Clients
    if (url === '/api/invoke' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const { channel, args } = JSON.parse(body);
                
                // Special handling for auth actions via proxy
                if (channel === 'auth-login' || channel === 'auth-register' || channel === 'auth-has-users') {
                    // These are allowed even if not authenticated if they come with x-auth-action header
                } else if (!isAuthenticated) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Unauthorized' }));
                } else if (!canUseApp && channel !== 'auth-check' && channel !== 'auth-logout') {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Account pending admin approval' }));
                } else if (channel.startsWith('agent-') && !canUseTools) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Tool usage restricted by Administrator' }));
                }

                // Special trap to let host know LMS server changed from web UI.
                // Validate it's a well-formed http(s) URL and not a metadata/link-local
                // host before trusting it (it feeds the proxy allowlist).
                if (channel === 'set-lms-url') {
                    let candidate;
                    try { candidate = new URL(String(args[0])); } catch (e) { candidate = null; }
                    if (!candidate || (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') || isBlockedHost(candidate.hostname)) {
                        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        return res.end(JSON.stringify({ error: 'Invalid LLM server URL' }));
                    }
                    lmsHostUrl = candidate.toString();
                    try { memoryManager.setLlmBase(lmsHostUrl); } catch (e) { /* optional */ }
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    return res.end(JSON.stringify({ success: true }));
                }

                const handler = webHandlers.get(channel);
                if (handler) {
                    const val = await handler({ sender: { send: () => {} } }, ...args);
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify(val));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'No handler for ' + channel }));
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // File Download Endpoint — only files inside the project root / app data may be
    // served (previously any absolute path → arbitrary file read for authd users).
    if (url.startsWith('/download_remote')) {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const fileToDownload = parsedUrl.searchParams.get('file');
        const safePath = validateDownloadPath(fileToDownload);
        if (safePath) {
            const safeName = path.basename(safePath).replace(/["\r\n]/g, '_');
            res.writeHead(200, {
                'Content-Disposition': `attachment; filename="${safeName}"`,
                'Access-Control-Allow-Origin': '*'
            });
            const readStream = fs.createReadStream(safePath);
            readStream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
            readStream.pipe(res);
            return;
        } else {
            res.writeHead(403, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
            res.end('File not found or not permitted');
            return;
        }
    }

    // Static File Serving
    // Decode and contain within __dirname to prevent path traversal
    // (e.g. "/../../secret.js" — extensions like .js/.css bypass the auth gate above).
    let decodedUrl;
    try {
        decodedUrl = decodeURIComponent(url);
    } catch (e) {
        decodedUrl = url;
    }
    const appDir = path.resolve(__dirname);
    let filePath = path.resolve(appDir, '.' + (decodedUrl === '/' ? '/index.html' : decodedUrl));
    const relToApp = path.relative(appDir, filePath);
    if (relToApp.startsWith('..') || path.isAbsolute(relToApp)) {
        res.writeHead(403, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        return res.end('Forbidden');
    }
    fs.promises.readFile(filePath)
        .then(content => {
            const ext = path.extname(filePath);
            const contentType = {
                '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.png': 'image/png', '.jpg': 'image/jpeg'
            }[ext] || 'text/plain';
            res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
            res.end(content);
        })
        .catch(e => {
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
            res.end('Not Found');
        });
});

let remoteUrl = null;
async function startCloudflareTunnel() {
    const cfPath = path.join(app.getPath('userData'), 'cloudflared');
    const platform = process.platform;
    const arch = process.arch;
    
    let downloadUrl = "";
    if (platform === 'linux' && arch === 'x64') {
        downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
    } else if (platform === 'win32' && arch === 'x64') {
        downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
    }

    if (!fs.existsSync(cfPath) && downloadUrl) {
        console.log('Downloading cloudflared for remote hosting...');
        try {
            if (platform === 'linux') {
                execSync(`wget -O "${cfPath}" "${downloadUrl}"`);
                fs.chmodSync(cfPath, 0o755);
            } else {
                // Fallback or skip for other platforms in this specific environment
            }
            console.log('cloudflared downloaded successfully.');
        } catch (err) {
            console.error('Failed to download cloudflared:', err);
            return;
        }
    }

    if (fs.existsSync(cfPath)) {
        console.log('Starting Cloudflare Tunnel...');
        const cfProcess = spawn(cfPath, ['tunnel', '--url', `http://localhost:${WEB_PORT}`]);
        
        cfProcess.stderr.on('data', (data) => {
            const output = data.toString();
            const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
            if (match && !remoteUrl) {
                remoteUrl = match[0];
                console.log('\n=========================================');
                console.log(' Remote Access URL: ' + remoteUrl);
                console.log('=========================================\n');
            }
        });

        cfProcess.on('close', (code) => {
            console.log(`cloudflared process exited with code ${code}`);
            remoteUrl = null;
        });
    }
}

webServer.listen(WEB_PORT, '0.0.0.0', () => {
    console.log('\n=========================================');
    console.log(' Web Interface hosted at: http://' + getLocalIP() + ':' + WEB_PORT);
    console.log('=========================================\n');
    startCloudflareTunnel().catch(console.error);
});

ipcMain.handle('get-host-url', async () => {
    return { 
        url: 'http://' + getLocalIP() + ':' + WEB_PORT,
        remoteUrl: remoteUrl
    };
});

ipcMain.handle('open-external-url', async (event, url) => {
    try {
        await shell.openExternal(url);
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('get-env-info', async () => {
    const selectedRoot = projectContext.getRootOrNull();
    return {
        platform: os.platform(),
        arch: os.arch(),
        homedir: os.homedir(),
        username: os.userInfo().username,
        // The agent must operate on the user-selected workspace, not the app's
        // own install dir. Report the project root as cwd; expose both fields so
        // callers can tell whether a workspace was actually chosen.
        cwd: projectContext.getRoot(),
        projectRoot: selectedRoot,
        appDir: process.cwd()
    };
});
