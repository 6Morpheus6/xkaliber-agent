// --- Polyfill for Non-Electron Environments (Mobile/Web) ---
const isWebMode = window.location.protocol.startsWith('http');

if (!window.api) {
    window.api = {
        invoke: async (channel, ...args) => {
            try {
                const token = localStorage.getItem('auth_token');
                const headers = { 'Content-Type': 'application/json' };
                if (token) headers['Authorization'] = `Bearer ${token}`;
                
                // Special actions that are allowed without a token if the server allows it
                if (['auth-login', 'auth-register', 'auth-has-users'].includes(channel)) {
                    headers['x-auth-action'] = channel.replace('auth-', '');
                }

                const response = await fetch('/api/invoke', {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({ channel, args })
                });
                return await response.json();
            } catch (e) {
                return { error: e.message };
            }
        },
        on: () => {},
        send: () => {}
    };
}

if (!window.markedParse) {
    window.markedParse = (text) => {
        if (typeof marked !== 'undefined' && marked.parse) {
            return marked.parse(text);
        }
        return text; // Fallback to raw text if marked is not available
    };
}

if (isWebMode) {
    const originalFetch = window.fetch;
    window.fetch = async (input, init = {}) => {
        let urlStr = typeof input === 'string' ? input : input.url;
        
        const token = localStorage.getItem('auth_token');
        if (token) {
            init.headers = { ...init.headers, 'Authorization': `Bearer ${token}` };
        }

        // Proxy ALL absolute HTTP requests through the Node host proxy to bypass CORS
        if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
            // Mobile devices can't hit localhost directly, so we tell the host to route to 127.0.0.1
            if (urlStr.includes('localhost')) {
                urlStr = urlStr.replace('localhost', '127.0.0.1');
            }
            const targetUrl = urlStr;
            urlStr = '/api/proxy/';
            init.headers = { ...init.headers, 'x-target-url': targetUrl };
        }
        return originalFetch(urlStr, init);
    };
}

// DOM Elements
const modelSelect = document.getElementById('model-select');
const tempSlider = document.getElementById('temp-slider');
const tempVal = document.getElementById('temp-val');
const ctxSlider = document.getElementById('ctx-slider');
const ctxVal = document.getElementById('ctx-val');
const stepsSlider = document.getElementById('steps-slider');
const stepsVal = document.getElementById('steps-val');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const messagesContainer = document.getElementById('messages');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const attachBtn = document.getElementById('attach-btn');
const attachmentsBar = document.getElementById('attachments-bar');
const memoryToggle = document.getElementById('memory-toggle');
const sudoInput = document.getElementById('sudo-input');
const memoryIndicator = document.getElementById('memory-indicator');
const memoryCountBadge = document.getElementById('memory-count-badge');
const clearBtn = document.getElementById('clear-btn');
const ttsToggle = document.getElementById('tts-toggle');
const localTtsToggle = document.getElementById('local-tts-toggle');
const testAudioBtn = document.getElementById('test-audio-btn');

function localSpeak(text) {
    if (!window.speechSynthesis) {
        addMessage('system', 'Web Speech API (TTS) is not supported in this browser.');
        return;
    }
    // Cancel any ongoing speech
    window.speechSynthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    // Use a slightly more natural rate
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    
    window.speechSynthesis.speak(utterance);
}
const netrunnerToggle = document.getElementById('netrunner-toggle');
const exportBtn = document.getElementById('export-btn');
const importBtn = document.getElementById('import-btn');

// --- Hardware Guard Elements (v30) ---
const hardwareMonitor = document.getElementById('hardware-monitor');
const vramInfo = document.getElementById('vram-info');
const ramInfo = document.getElementById('ram-info');
const gpuLoad = document.getElementById('gpu-load');
const hardResetBtn = document.getElementById('hard-reset-btn');
const vramBarFill = document.getElementById('vram-bar-fill');
const ramBarFill = document.getElementById('ram-bar-fill');

// --- Uplink Mode & Server Config ---
const uplinkMode = { checked: true }; // Forced true in v39.4: Ollama removed from UI selection
const lmsServerContainer = document.getElementById('lms-server-container');
const lmsServerInput = document.getElementById('lms-server-input');

// --- Auth Elements ---
const loginOverlay = document.getElementById('login-overlay');
const loginFields = document.getElementById('login-fields');
const registerFields = document.getElementById('register-fields');
const authTitle = document.getElementById('auth-title');
const authUsername = document.getElementById('auth-username');
const authPassword = document.getElementById('auth-password');
const loginBtn = document.getElementById('login-btn');
const authSwitchText = document.getElementById('auth-switch-text');
const regUsername = document.getElementById('reg-username');
const regPassword = document.getElementById('reg-password');
const regPasswordConfirm = document.getElementById('reg-password-confirm');
const registerSubmitBtn = document.getElementById('register-submit-btn');
const regSwitchText = document.getElementById('reg-switch-text');
const authError = document.getElementById('auth-error');
const currentUserDisplay = document.getElementById('current-user-display');
const logoutBtn = document.getElementById('logout-btn');
const adminPanelBtn = document.getElementById('admin-panel-btn');
const adminOverlay = document.getElementById('admin-overlay');
const adminUserList = document.getElementById('admin-user-list');
const closeAdminBtn = document.getElementById('close-admin-btn');
const agentToggle = document.getElementById('agent-toggle');

const OLLAMA_API = 'http://127.0.0.1:11434/api';
let currentApiBase = 'http://localhost:1234'; 

if (lmsServerInput) {
    lmsServerInput.addEventListener('change', () => {
        updateApiBase();
        fetchModels();
    });
}

function updateApiBase() {
    let server = lmsServerInput.value.trim();
    if (server.endsWith('/')) server = server.slice(0, -1);
    currentApiBase = server;
    // Notify host of URL change (for any host-side features)
    window.api.invoke('set-lms-url', [currentApiBase]);
}

let attachedFiles = [];
let abortController = null;
let chatHistory = [];

// --- WhatsApp wiring ---
const waLinkBtn = document.getElementById('wa-link-btn');
const qrModal = document.getElementById('qr-modal');
const qrImage = document.getElementById('qr-image');
const closeQr = document.getElementById('close-qr');

if (waLinkBtn) {
    waLinkBtn.addEventListener('click', async () => {
        waLinkBtn.disabled = true;
        waLinkBtn.textContent = 'CONNECTING...';
        const res = await window.api.invoke('whatsapp-init');
        if (res?.error) {
            addMessage('system', `**WhatsApp Error:** ${res.error}`);
            waLinkBtn.disabled = false;
            waLinkBtn.textContent = 'LINK WHATSAPP';
        }
    });
}

window.api.on('whatsapp-qr', (dataUrl) => {
    if (qrModal && qrImage) {
        qrImage.src = dataUrl;
        qrModal.style.display = 'flex';
    }
});

window.api.on('whatsapp-ready', () => {
    if (qrModal) qrModal.style.display = 'none';
    if (waLinkBtn) { waLinkBtn.textContent = 'WHATSAPP LINKED'; waLinkBtn.disabled = true; }
    addMessage('system', 'WhatsApp linked successfully.');
});

window.api.on('whatsapp-error', (msg) => {
    addMessage('system', `**WhatsApp Auth Error:** ${msg}`);
    if (waLinkBtn) { waLinkBtn.disabled = false; waLinkBtn.textContent = 'LINK WHATSAPP'; }
});

window.api.on('whatsapp-disconnected', () => {
    addMessage('system', 'WhatsApp disconnected.');
    if (waLinkBtn) { waLinkBtn.disabled = false; waLinkBtn.textContent = 'LINK WHATSAPP'; }
});

if (closeQr) {
    closeQr.addEventListener('click', () => { if (qrModal) qrModal.style.display = 'none'; });
}

// --- TTS controls ---
if (testAudioBtn) {
    testAudioBtn.addEventListener('click', () => {
        const msg = 'Xkaliber Agent audio uplink is operational.';
        if (localTtsToggle?.checked) {
            localSpeak(msg);
        } else {
            window.api.send('tts-speak', msg);
        }
    });
}

window.api.on('tts-error', (msg) => addMessage('system', `**TTS Error:** ${msg}`));

// --- Attachment Handling ---
const fileInput = document.getElementById('file-input');

if (attachBtn) {
    attachBtn.addEventListener('click', async () => {
        // If we're in a browser (not Electron), use the HTML input
        if (isWebMode) {
            fileInput.click();
        } else {
            const file = await window.api.invoke('open-file-dialog');
            if (file && !file.error) {
                attachedFiles.push(file);
                renderAttachments();
            } else if (file?.error) {
                addMessage('system', `**ATTACHMENT ERROR**: ${file.error}`);
            }
        }
    });
}

if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const isImage = file.type.startsWith('image/');
        const reader = new FileReader();
        
        reader.onload = async (event) => {
            let fileData;
            if (isImage) {
                if (file.size > 50 * 1024 * 1024) {
                    addMessage('system', 'Image file is too large (over 50MB limit).');
                    return;
                }
                const base64 = event.target.result.split(',')[1];
                fileData = {
                    fileName: file.name,
                    isImage: true,
                    base64: base64,
                    size: file.size
                };
            } else {
                let content = event.target.result;
                if (file.size >= 1024 * 1024) {
                    content = `[FILE TOO LARGE TO AUTO-READ: ${file.size} bytes. Use read_file tool if it exists on host.]`;
                }
                fileData = {
                    fileName: file.name,
                    isImage: false,
                    content: content,
                    size: file.size
                };
            }
            attachedFiles.push(fileData);
            renderAttachments();
            fileInput.value = ''; // Reset
        };

        if (isImage) {
            reader.readAsDataURL(file);
        } else {
            reader.readAsText(file);
        }
    });
}

function renderAttachments() {
    attachmentsBar.innerHTML = '';
    attachedFiles.forEach((file, index) => {
        const tag = document.createElement('div');
        tag.className = 'attachment-tag';
        tag.innerHTML = `${file.isImage ? '🖼️' : '📎'} ${file.fileName} <span class="remove-attach" data-index="${index}">×</span>`;
        attachmentsBar.appendChild(tag);
    });
    document.querySelectorAll('.remove-attach').forEach(btn => {
        btn.onclick = (e) => {
            attachedFiles.splice(parseInt(e.target.dataset.index), 1);
            renderAttachments();
        };
    });
}

// --- Param Displays ---
[tempSlider, stepsSlider].forEach(s => s && s.addEventListener('input', () => {
    if (tempVal) tempVal.textContent = parseFloat(tempSlider.value).toFixed(1);
    if (stepsVal) stepsVal.textContent = stepsSlider.value;
}));

// --- Agent Tool Definitions ---
const AGENT_TOOLS = [
    {
        type: "function",
        function: {
            name: "provide_file_download_link",
            description: "Provide the user with a direct download link to a file on the host system. Useful when the user is accessing the agent remotely and needs to download a local file.",
            parameters: { type: "object", properties: { filepath: { type: "string" } }, required: ["filepath"] }
        }
    },
    {
        type: "function",
        function: {
            name: "run_shell_command",
            description: "Execute a bash shell command. USE THIS to check system state, running processes (e.g., 'ps aux', 'top'), network, or execute scripts. If sudo is needed, it will be automatically handled. If the task is long-running (like compilation or starting a server), set is_background to true and use the returned job ID with read_process_log.",
            parameters: { type: "object", properties: { command: { type: "string" }, is_background: { type: "boolean", description: "Set to true to run in the background and return a job ID immediately." } }, required: ["command"] }
        }
    },
    {
        type: "function",
        function: {
            name: "read_process_log",
            description: "Read the output log of a background process started with run_shell_command. Use this to check progress of long-running tasks without blocking.",
            parameters: { type: "object", properties: { job_id: { type: "string", description: "The job ID returned when starting the background process." }, lines: { type: "number", description: "Number of lines to read from the end of the log (default 50)." } }, required: ["job_id"] }
        }
    },
    {
        type: "function",
        function: {
            name: "send_input",
            description: "Send standard input (like 'Y' or a password) to an active background process.",
            parameters: { type: "object", properties: { job_id: { type: "string", description: "The job ID of the background process." }, input: { type: "string", description: "The input string to send." } }, required: ["job_id", "input"] }
        }
    },
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read a file from the host system.",
            parameters: { type: "object", properties: { filepath: { type: "string" } }, required: ["filepath"] }
        }
    },
    {
        type: "function",
        function: {
            name: "write_file",
            description: "Write content to a file.",
            parameters: { type: "object", properties: { filepath: { type: "string" }, content: { type: "string" } }, required: ["filepath", "content"] }
        }
    },
    {
        type: "function",
        function: {
            name: "list_directory",
            description: "List contents (files and folders) of a directory on the file system. DO NOT use this to find running applications; use run_shell_command with 'ps' instead.",
            parameters: { type: "object", properties: { dirpath: { type: "string" } }, required: ["dirpath"] }
        }
    },
    {
        type: "function",
        function: {
            name: "delete_file",
            description: "Delete a file or directory from the host system.",
            parameters: { type: "object", properties: { filepath: { type: "string" } }, required: ["filepath"] }
        }
    },
    {
        type: "function",
        function: {
            name: "save_new_user_fact_only",
            description: "Saves a permanent fact to memory. EXTREMELY STRICT RULES: DO NOT use this for casual chat, greetings (e.g. 'hi', 'how are you'), or temporary thoughts. ONLY use this if the user states a highly important, permanent fact about themselves (e.g. 'I am allergic to peanuts'). If the input is trivial, DO NOT USE THIS TOOL.",
            parameters: { type: "object", properties: { exact_new_fact: { type: "string", description: "The distinct, highly important permanent fact extracted ONLY from the latest message." } }, required: ["exact_new_fact"] }
        }
    },
    {
        type: "function",
        function: {
            name: "memory_search",
            description: "Search long-term vector memory to recall past learned knowledge, user preferences, or facts. USE THIS TOOL actively if you are asked a question about the user or past context that you do not know the answer to. Formulate a targeted search query.",
            parameters: { type: "object", properties: { query: { type: "string", description: "The specific topic or keywords to search for in memory." } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "dynamic_schema_generate",
            description: "Generate a dynamic JSON schema for a task.",
            parameters: { type: "object", properties: { task: { type: "string" }, fields: { type: "array", items: { type: "string" } } }, required: ["task", "fields"] }
        }
    },
    {
        type: "function",
        function: {
            name: "web_search",
            description: "Search the web.",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
        }
    },
    {
        type: "function",
        function: {
            name: "send_whatsapp_message",
            description: "Send a WhatsApp message.",
            parameters: { type: "object", properties: { number: { type: "string" }, message: { type: "string" } }, required: ["number", "message"] }
        }
    },
    {
        type: "function",
        function: {
            name: "memory_purge",
            description: "Request the system to immediately free up unused RAM/VRAM. Use this if you are performing a very large task (like building an entire app) and feel that system resources are becoming congested. This will prune older history and trigger garbage collection.",
            parameters: { type: "object", properties: { reason: { type: "string", description: "The reason for the purge." } }, required: ["reason"] }
        }
    }
];

// --- Memory helpers ---
async function pageOutModel(modelName) {
    if (!modelName || uplinkMode.checked) return;
    if (isSending) {
        console.warn(`[PAGING] Skipping page out for ${modelName} because a generation task is currently active.`);
        return;
    }
    console.log(`[PAGING] Paging out model: ${modelName} to free VRAM.`);
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        await fetch(`${OLLAMA_API}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelName, messages: [], keep_alive: 0 }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
    } catch(e) { console.warn(`[PAGING] Failed to page out ${modelName}`, e.message); }
}

async function updateMemoryCount() {
    if (memoryCountBadge) {
        try {
            const countRes = await window.api.invoke('mem-count');
            // Backend returns raw number on desktop, but might be wrapped or error in proxy
            let finalCount = 0;
            if (typeof countRes === 'number') finalCount = countRes;
            else if (countRes && typeof countRes.count === 'number') finalCount = countRes.count;
            else if (countRes && !countRes.error) finalCount = parseInt(countRes) || 0;
            
            memoryCountBadge.textContent = `[${finalCount} MEMS]`;
        } catch (e) {
            console.warn('Failed to update memory count:', e);
        }
    }
}

async function saveToMemory(text) {
    if (!memoryToggle.checked || !text) return { error: "Memory disabled" };
    memoryIndicator.style.display = 'block';
    const res = await window.api.invoke('mem-store', { text });
    setTimeout(() => { memoryIndicator.style.display = 'none'; }, 2000);
    return res;
}

async function searchMemory(query) {
    const res = await window.api.invoke('mem-query', { query, limit: 5 });
    if (res?.success) return res.data.filter(r => r.similarity > 0.15);
    return [];
}

// --- Clear / Export / Import ---
if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
        await window.api.invoke('clear-history');
        await window.api.invoke('mem-clear');
        chatHistory = [];
        messagesContainer.innerHTML = '<div class="message bot-message"><strong>SYSTEM:</strong> Neural memory wiped.</div>';
        updateMemoryCount();
    });
}

if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
        if (chatHistory.length === 0) { addMessage('system', 'Nothing to export.'); return; }
        const result = await window.api.invoke('export-session', chatHistory);
        if (result?.success) addMessage('system', `Session exported to **${result.filePath}**`);
    });
}

if (importBtn) {
    importBtn.addEventListener('click', async () => {
        const data = await window.api.invoke('import-session');
        if (data?.error) { addMessage('system', `**Import Error:** ${data.error}`); return; }
        if (data && Array.isArray(data)) {
            chatHistory = data;
            messagesContainer.innerHTML = '';
            renderHistory();
            await window.api.invoke('save-history', chatHistory);
            addMessage('system', 'Session imported successfully.');
        }
    });
}

// --- Init & Connection ---
let authToken = localStorage.getItem('auth_token');

async function checkAuth() {
    if (!authToken) {
        showLogin();
        return;
    }
    const res = await window.api.invoke('auth-check', authToken);
    if (res.authenticated) {
        hideLogin(res.user);
    } else {
        localStorage.removeItem('auth_token');
        authToken = null;
        showLogin();
    }
}

function showLogin() {
    loginOverlay.style.display = 'flex';
    // Check if any users exist
    window.api.invoke('auth-has-users').then(res => {
        if (res && !res.hasUsers) {
            showRegister();
            authTitle.textContent = 'CREATE ADMIN ACCOUNT';
            if (regSwitchText) regSwitchText.style.display = 'none';
        }
    });
}

function hideLogin(user) {
    loginOverlay.style.display = 'none';
    currentUserDisplay.textContent = `User: ${user.username}`;
    
    if (user.role === 'admin') {
        adminPanelBtn.style.display = 'block';
    } else {
        adminPanelBtn.style.display = 'none';
    }

    if (!user.permissions.canUseTools) {
        agentToggle.checked = false;
        agentToggle.disabled = true;
        agentToggle.parentElement.style.opacity = '0.5';
        agentToggle.parentElement.title = 'Disabled by Administrator';
    } else {
        agentToggle.disabled = false;
        agentToggle.parentElement.style.opacity = '1';
        agentToggle.parentElement.title = '';
    }

    init();
}

function showRegister() {
    loginFields.style.display = 'none';
    registerFields.style.display = 'block';
    authTitle.textContent = 'CREATE ACCOUNT';
}

function showLoginForm() {
    registerFields.style.display = 'none';
    loginFields.style.display = 'block';
    authTitle.textContent = 'LOGIN REQUIRED';
}

if (authSwitchText) authSwitchText.addEventListener('click', showRegister);
if (regSwitchText) regSwitchText.addEventListener('click', showLoginForm);

if (loginBtn) {
    loginBtn.addEventListener('click', async () => {
        const username = authUsername.value.trim();
        const password = authPassword.value;
        if (!username || !password) return;
        
        loginBtn.disabled = true;
        authError.textContent = '';
        const res = await window.api.invoke('auth-login', { username, password });
        if (res.success) {
            authToken = res.token;
            localStorage.setItem('auth_token', authToken);
            checkAuth();
        } else {
            authError.textContent = res.error;
        }
        loginBtn.disabled = false;
    });
}

if (registerSubmitBtn) {
    registerSubmitBtn.addEventListener('click', async () => {
        const username = regUsername.value.trim();
        const password = regPassword.value;
        const confirm = regPasswordConfirm.value;
        
        if (!username || !password) return;
        if (password !== confirm) {
            authError.textContent = 'Passwords do not match';
            return;
        }
        
        registerSubmitBtn.disabled = true;
        authError.textContent = '';
        const res = await window.api.invoke('auth-register', { username, password });
        if (res.success) {
            authError.style.color = 'var(--accent-color)';
            authError.textContent = 'Account created! Please sign in.';
            setTimeout(() => {
                authError.style.color = '';
                showLoginForm();
            }, 1500);
        } else {
            authError.textContent = res.error;
        }
        registerSubmitBtn.disabled = false;
    });
}

if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
        if (authToken) await window.api.invoke('auth-logout', authToken);
        localStorage.removeItem('auth_token');
        authToken = null;
        location.reload();
    });
}

// --- Admin Panel Logic ---
if (adminPanelBtn) {
    adminPanelBtn.addEventListener('click', async () => {
        adminOverlay.style.display = 'flex';
        await renderAdminUserList();
    });
}

if (closeAdminBtn) {
    closeAdminBtn.addEventListener('click', () => {
        adminOverlay.style.display = 'none';
    });
}

async function renderAdminUserList() {
    adminUserList.innerHTML = '<p style="color:var(--text-color);">Loading users...</p>';
    const res = await window.api.invoke('auth-get-users', authToken);
    if (!res.success) {
        adminUserList.innerHTML = `<p style="color:#ff4444;">Error: ${res.error}</p>`;
        return;
    }

    adminUserList.innerHTML = '';
    res.users.forEach(user => {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.05); padding: 10px; border-radius: 4px; border: 1px solid var(--border-color);';
        
        const isSelf = currentUserDisplay.textContent.includes(user.username);
        
        row.innerHTML = `
            <div>
                <strong style="color: var(--accent-color);">${user.username}</strong>
                <span style="font-size: 0.7rem; color: #8b949e; margin-left: 5px;">[${user.role.toUpperCase()}]</span>
            </div>
            <div style="display: flex; gap: 15px;">
                <label style="display:flex; align-items:center; gap:5px; font-size:0.8rem; color:var(--text-color); cursor:${isSelf ? 'not-allowed' : 'pointer'};">
                    <input type="checkbox" class="perm-toggle" data-user="${user.username}" data-perm="canUseApp" ${user.permissions.canUseApp ? 'checked' : ''} ${isSelf ? 'disabled' : ''}>
                    App Access
                </label>
                <label style="display:flex; align-items:center; gap:5px; font-size:0.8rem; color:var(--text-color); cursor:${isSelf ? 'not-allowed' : 'pointer'};">
                    <input type="checkbox" class="perm-toggle" data-user="${user.username}" data-perm="canUseTools" ${user.permissions.canUseTools ? 'checked' : ''} ${isSelf ? 'disabled' : ''}>
                    Tool Access
                </label>
            </div>
        `;
        adminUserList.appendChild(row);
    });

    document.querySelectorAll('.perm-toggle').forEach(toggle => {
        toggle.addEventListener('change', async (e) => {
            const targetUsername = e.target.dataset.user;
            const perm = e.target.dataset.perm;
            const value = e.target.checked;
            
            e.target.disabled = true;
            const updateRes = await window.api.invoke('auth-update-user', {
                token: authToken,
                targetUsername: targetUsername,
                permissions: { [perm]: value }
            });
            
            if (!updateRes.success) {
                alert(`Failed to update permissions: ${updateRes.error}`);
                e.target.checked = !value; // Revert UI
            }
            e.target.disabled = false;
        });
    });
}

async function init() {
    try {
        const urlDispContainer = document.getElementById('host-url-container');
        const urlDisp = document.getElementById('host-url-display');
        if (isWebMode) {
            if (urlDispContainer) urlDispContainer.style.display = 'none';
        } else {
            const hostInfo = await window.api.invoke('get-host-url');
            if (hostInfo && urlDisp) {
                let displayHtml = `Local: ${hostInfo.url}`;
                if (hostInfo.remoteUrl) {
                    displayHtml += ` | Remote: <a href="${hostInfo.remoteUrl}" target="_blank" style="color: #00ff00;">${hostInfo.remoteUrl}</a>`;
                } else {
                    displayHtml += ` | Remote: (Starting...)`;
                    // Refresh every few seconds until remoteUrl is available
                    const refreshInterval = setInterval(async () => {
                        const updatedInfo = await window.api.invoke('get-host-url');
                        if (updatedInfo.remoteUrl) {
                            urlDisp.innerHTML = `Local: ${updatedInfo.url} | Remote: <a href="${updatedInfo.remoteUrl}" target="_blank" style="color: #00ff00;">${updatedInfo.remoteUrl}</a>`;
                            clearInterval(refreshInterval);
                        }
                    }, 5000);
                }
                urlDisp.innerHTML = displayHtml;
            }
        }
    } catch(e) {}

    try {
        await fetchModels();
        checkConnection();
        chatHistory = await window.api.invoke('load-history');
        
        if (chatHistory && chatHistory.error) {
            console.error("Backend error loading history:", chatHistory.error);
            chatHistory = [];
        } else if (!Array.isArray(chatHistory)) {
            chatHistory = [];
        }

        let envContext = "";
        try {
            const envInfo = await window.api.invoke('get-env-info');
            if (envInfo && !envInfo.error) {
                envContext = `\n\n[SYSTEM ENVIRONMENT]:\nOS: ${envInfo.platform} (${envInfo.arch})\nUser: ${envInfo.username}\nHome Dir: ${envInfo.homedir}\nCurrent Dir: ${envInfo.cwd}\n`;
            }
        } catch (e) {}

        const systemPrompt = `You are Xkaliber Agent v39.4, a conversational AI assistant (AMD Optimized). You have access to persistent vector memory, web search, and system tools. Respond naturally and conversationally to the user. Do not invoke tools for casual conversation or greetings.

        GUARD RAILS:
        1. SECURE ACCESS: This version (v39.4) includes secure login and account creation. Access is restricted to authorized users only.
2. STRICT ACTION LIMITS: Never use file modification tools unless explicitly requested by the user. If the user asks to download a file, ALWAYS use the provide_file_download_link tool. 
3. NO UNPROMPTED SETUP: Do not set up configuration files or scripts unprompted. If you are asked to read or list files, do not follow up with write actions. 
4. PREVENT HALLUCINATIONS: If you are unsure of the user's intent or lack context, DO NOT guess or hallucinate a tool call. Instead, ask the user for clarification.

WEB SEARCH GUIDELINES:
When you use the web_search tool, you must provide the findings to the user as clean, natural language. Explain the information from a first-person perspective (e.g., 'I found that...'). Avoid using bullet points, numbered lists, or cluttered responses. Instead, present the search results as a cohesive, conversational narrative.

MEMORY DIRECTIVES:
You have a tool called save_new_user_fact_only. You must be EXTREMELY SELECTIVE with this tool.
- DO NOT save casual conversation, greetings, or temporary thoughts.
- ONLY save permanent, highly important facts (e.g., "I am allergic to peanuts", "My favorite color is blue", "I work as a software engineer").
- NEVER save a fact that was already saved or discussed in previous messages.
- If the user says something trivial, just chat with them normally and DO NOT use the memory tool.${envContext}`;

        if (!chatHistory || chatHistory.length === 0) {
            chatHistory = [{ role: "system", content: baseSystemPrompt }];
        } else if (chatHistory.length > 0 && chatHistory[0].role === 'system') {
            chatHistory[0].content = baseSystemPrompt;
        }

        if (chatHistory.length > 0) {
            messagesContainer.innerHTML = '';
            renderHistory();
        }
        updateMemoryCount();

    } catch (err) {
        setStatus(false, 'OFFLINE');
    }
}

async function fetchModels(retries = 3) {
    try {
        // LM Studio / OpenAI Format (Primary UI backend in v39.4)
        const res = await fetch(`${currentApiBase}/v1/models`, {
            headers: { 'Authorization': 'Bearer lm-studio' }
        });
        if (!res.ok) throw new Error('AI Backend Offline or Incorrect URL');
        const data = await res.json();
        const models = data.data || data; 
        if (Array.isArray(models)) {
            modelSelect.innerHTML = models.map(m => `<option value="${m.id || m}">${m.id || m}</option>`).join('');
        } else {
            throw new Error('Unexpected models format');
        }
    } catch (err) {
        console.error(`Fetch Models Error (retries left: ${retries}):`, err);
        if (retries > 0) {
            modelSelect.innerHTML = `<option value="" disabled selected>Scanning... (Retrying)</option>`;
            await new Promise(r => setTimeout(r, 2000));
            return fetchModels(retries - 1);
        }
        modelSelect.innerHTML = '<option value="" disabled selected>Error Loading Models</option>';
    }
}

function setStatus(online, text) {
    statusText.textContent = text;
    statusDot.className = `dot ${online ? 'connected' : ''}`;
    if (!isSending) {
        userInput.disabled = !online;
        sendBtn.disabled = !online;
    }
}

// --- v30: Hardware Guard Logic ---
let connectionFailureCount = 0;
let isHardwareMonitorActive = false;

async function checkHardwareHealth() {
    if (isWebMode) return;
    
    try {
        const telemetry = await window.api.invoke('get-gpu-telemetry');
        if (telemetry) {
            // Always show monitor if we have telemetry
            hardwareMonitor.style.display = 'block';
            
            if (telemetry.systemRam) {
                const sysPct = ((telemetry.systemRam.used / telemetry.systemRam.total) * 100).toFixed(0);
                if (ramInfo) ramInfo.textContent = `${telemetry.systemRam.used}MB / ${telemetry.systemRam.total}MB (${sysPct}%)`;
                if (ramBarFill) {
                    ramBarFill.style.width = `${sysPct}%`;
                    ramBarFill.style.backgroundColor = sysPct > 90 ? '#ff4444' : (sysPct > 80 ? '#ffb703' : '#008f11');
                }
            }

            if (!telemetry.error && telemetry.memory) {
                isHardwareMonitorActive = true;
                const usedMB = telemetry.memory.used;
                const totalMB = telemetry.memory.total;
                const vramPct = ((usedMB / totalMB) * 100).toFixed(0);
                
                vramInfo.textContent = `${usedMB}MB / ${totalMB}MB (${vramPct}%)`;
                vramInfo.style.color = telemetry.is_high_pressure ? '#ff4444' : (vramPct > 80 ? '#ffb703' : '#8b949e');
                
                if (vramBarFill) {
                    vramBarFill.style.width = `${vramPct}%`;
                    vramBarFill.style.backgroundColor = telemetry.is_high_pressure ? '#ff4444' : (vramPct > 80 ? '#ffb703' : 'var(--accent-color)');
                }
                
                gpuLoad.textContent = `${telemetry.utilization}%`;
                gpuLoad.style.color = telemetry.utilization > 90 ? '#ff4444' : (telemetry.utilization > 70 ? '#ffb703' : '#8b949e');

                if (telemetry.is_high_pressure && !isSending) {
                    console.warn('[WATCHDOG] High VRAM pressure detected.');
                }
            } else if (telemetry.error) {
                 vramInfo.textContent = 'NO NVIDIA GPU';
                 vramInfo.style.color = '#8b949e';
                 gpuLoad.textContent = '0%';
            }
        }
    } catch (e) {
        console.error('Hardware health check failed:', e);
    }
}

async function checkConnection() {
    const endpoint = `${currentApiBase}/v1/models`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout for health check

    try {
        const res = await fetch(endpoint, { 
            headers: { 'Authorization': 'Bearer lm-studio' },
            signal: controller.signal 
        });        clearTimeout(timeoutId);
        
        if (res.ok) {
            setStatus(true, 'ONLINE');
            connectionFailureCount = 0;
        } else {
            throw new Error('Endpoint returned error');
        }
    } catch (err) {
        clearTimeout(timeoutId);
        connectionFailureCount++;
        setStatus(false, connectionFailureCount > 2 ? 'BACKEND HUNG' : 'OFFLINE');
        
        if (connectionFailureCount >= 3 && !isSending) {
            console.error('[WATCHDOG] AI Backend is not responding. VRAM might be full.');
            if (connectionFailureCount === 3) {
                addMessage('system', '⚠️ **Hardware Watchdog Alert:** AI backend is not responding. This often happens when VRAM is exhausted by a large model. If the app is locked, use **EMERGENCY RESET** in the sidebar.');
            }
        }
    }
    
    // Periodically sync memory count
    updateMemoryCount();
    
    // Check hardware telemetry
    checkHardwareHealth();
}
setInterval(checkConnection, 5000);

if (hardResetBtn) {
    hardResetBtn.addEventListener('click', async () => {
        const sudoPass = document.getElementById('sudo-input')?.value || '';
        const confirmed = confirm("This will attempt to Gracefully KILL AI backends and RESTART Xkaliber Agent. \n\nIf you have provided a Sudo Password, it will also attempt to restart the Ollama service properly to clear VRAM locks.\n\nContinue?");
        if (confirmed) {
            addMessage('system', 'Initiating emergency hardware reset. Please wait 3-5 seconds for VRAM to clear...');
            await window.api.invoke('app-reset', { killBackends: true, sudoPass });
        }
    });
}

function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = `message ${role === 'user' ? 'user-message' : role === 'system' ? 'system-message' : 'bot-message'}`;
    div.innerHTML = role === 'user' ? text : window.markedParse(text);
    messagesContainer.appendChild(div);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return div;
}

function renderHistory() {
    chatHistory.forEach(m => {
        if (m.role === 'user') addMessage('user', m.content);
        else if (m.role === 'assistant' && m.content) addMessage('bot', m.content);
        else if (m.role === 'assistant' && m.tool_calls) {
            m.tool_calls.forEach(t => {
                const l = document.createElement('div');
                l.className = 'agent-log';
                l.textContent = `⚡ Exec: ${t.function.name}\nArgs: ${JSON.stringify(t.function.arguments, null, 2)}`;
                messagesContainer.appendChild(l);
            });
        }
    });
}

// --- Tool executor (agent mode) ---
async function executeTool(name, args) {
    if (name === 'task_begin') {
        console.log(`Model started task: ${args.goal}`);
        return `Task acknowledged. Goal: ${args.goal}. Plan: ${args.plan.join(', ')}. Please proceed with the first step.`;
    }
    if (name === 'task_complete') {
        console.log(`Model completed task. Summary: ${args.summary}`);
        return `Task completion verified. Final summary received. You may now provide the final response to the user.`;
    }
    if (name === 'run_shell_command') {
        let cmd = args.command;
        const sudoPass = sudoInput.value;
        if (cmd.includes('sudo') && sudoPass) {
            cmd = cmd.replace(/sudo\s+/g, `echo "${sudoPass}" | sudo -S `);
        }
        const res = await window.api.invoke('agent-run-command', cmd, args.is_background);
        let out = "";
        if (res.error) out += `Error: ${res.error}\n`;
        if (res.stderr) out += `Stderr: ${res.stderr}\n`;
        if (res.stdout) out += `Stdout:\n${res.stdout}`;
        return out || "Success";
    }
    if (name === 'read_process_log') {
        const res = await window.api.invoke('agent-read-process-log', args.job_id, args.lines);
        return res.error ? `Error: ${res.error}` : res.log;
    }
    if (name === 'send_input') {
        const res = await window.api.invoke('agent-send-input', args.job_id, args.input);
        return res.success ? "Input sent successfully." : `Error: ${res.error}`;
    }
    if (name === 'read_file') return (await window.api.invoke('agent-read-file', args.filepath)).content || "Error reading";
    if (name === 'write_file') return (await window.api.invoke('agent-write-file', args.filepath, args.content)).success ? "Success" : "Error";
    if (name === 'list_directory') return (await window.api.invoke('agent-list-directory', args.dirpath)).files || "Error";
    if (name === 'delete_file') return (await window.api.invoke('agent-delete-file', args.filepath)).success ? "Success" : "Error";
    if (name === 'mem_store' || name === 'save_new_user_fact_only') {
        const factToStore = args.exact_new_fact || args.new_fact || args.text;
        const res = await saveToMemory(factToStore);
        if (res?.success) {
            updateMemoryCount();
            return "Memory stored successfully.";
        }
        return `Error: ${res?.error || "Failed to store memory"}`;
    }
    if (name === 'memory_search') {
        const mems = await searchMemory(args.query);
        return mems.length > 0 ? mems.map(m => m.text).join('\n') : "No memory found";
    }
    if (name === 'dynamic_schema_generate') {
        return JSON.stringify({ task: args.task, schema: { type: "object", properties: args.fields.reduce((a, f) => ({ ...a, [f]: { type: "string" } }), {}) } });
    }
    if (name === 'web_search') {
        const results = await window.api.invoke('perform-search', args.query);
        if (results && !results.error && results.length > 0) {
            return "I've conducted a web search and found several relevant pieces of information. " + results.map(r => `From a site titled "${r.title}" at ${r.url}, I learned that ${r.snippet}`).join(' Additionally, ');
        }
        return "I searched the web but couldn't find any relevant results for that query.";
    }
    if (name === 'send_whatsapp_message') return (await window.api.invoke('whatsapp-send', { number: args.number, message: args.message })).success ? "Success" : "Error";
    
    if (name === 'provide_file_download_link') {
        const encodedPath = encodeURIComponent(args.filepath);
        const fileName = args.filepath.split(/[\/\\]/).pop();
        return `I have generated the download link. Provide this exact markdown to the user: [Download ${fileName}](/download_remote?file=${encodedPath})`;
    }

    if (name === 'memory_purge') {
        console.log(`Model requested memory purge. Reason: ${args.reason}`);
        // Memory purge request handled contextually, no longer wipes UI history
        const model = modelSelect.value;
        if (model) await pageOutModel(model);
        return "Success: Resource optimization triggered. Model paged out to refresh VRAM. Context will be strictly managed on next turn.";
    }
    return `Unknown tool: ${name}`;
}

function stripMarkdown(text) {
    return text.replace(/[#*`_~\[\]()>]/g, '');
}

let currentResourceStatus = 'healthy';
window.api.on('resource-update', (data) => {
    currentResourceStatus = data.status;
    const statusDot = document.getElementById('resource-status-dot');
    if (statusDot) {
        statusDot.className = `status-dot ${data.status}`;
        statusDot.title = `Resource Status: ${data.status.toUpperCase()} (RAM: ${data.freePercent.toFixed(1)}% free, Proc: ${data.rssMB.toFixed(0)}MB)`;
    }
    
    if (data.status === 'congested') {
        console.warn(`[RESOURCE GUARD] High resource pressure detected. RSS: ${data.rssMB.toFixed(0)}MB. Triggering proactive cleanup on next payload generation.`);
        // Removed global UI prune to protect user history
    }
});

function pruneChatHistory(historyArray, forceAggressive = false, currentTurnCount = 0) {
    const memorySaverEnabled = document.getElementById('memory-saver-toggle')?.checked;
    const isActuallyCongested = currentResourceStatus === 'congested';
    
    // Adaptive limits based on resource pressure
    let MAX_LENGTH = 30;
    let TRIM_THRESHOLD = 8000;

    // ULTRA-AGGRESSIVE PRUNING for active autonomous loops (turnCount > 1)
    // We only need the system prompt, original task, plan, and immediate last step.
    const isDeepLoop = currentTurnCount > 1;

    if (isActuallyCongested || forceAggressive || isDeepLoop) {
        MAX_LENGTH = isDeepLoop ? 6 : 12; // Keep loop history extremely tight
        TRIM_THRESHOLD = isDeepLoop ? 1500 : 3000; // Aggressive truncation
    } else if (currentResourceStatus === 'warning') {
        MAX_LENGTH = 20;
        TRIM_THRESHOLD = 5000;
    }

    // --- LM STUDIO STRICT CONTEXT ENFORCEMENT ---
    const ctxLimitTokens = 131072; // Default to max since LM Studio handles it, but we need a cap for pruning.
    // Leave 45% for generation! Writing large files (like games) requires huge output limits.
    const allowedPromptTokens = Math.floor(ctxLimitTokens * 0.55); 
    const MAX_ALLOWED_CHARS = allowedPromptTokens * 3.5; // Approx 3.5 chars per token
    const needsStrictContextEnforcement = uplinkMode.checked || memorySaverEnabled || forceAggressive || isActuallyCongested || isDeepLoop;

    console.log(`Resource Manager: Checking history (status: ${currentResourceStatus}, loop: ${currentTurnCount}, current: ${historyArray.length} msgs)`);

    // 0. Identify critical messages that should NEVER be pruned if possible
    let taskIndex = -1;
    let planIndex = -1;

    for (let i = historyArray.length - 1; i >= 0; i--) {
        const m = historyArray[i];
        if (taskIndex === -1 && m.role === 'user') taskIndex = i;
        if (planIndex === -1 && m.tool_calls && m.tool_calls.some(tc => tc.function.name === 'task_begin')) planIndex = i;
    }

    // 1. Trim extremely large messages in history (except critical ones and the very last turn)
    if (needsStrictContextEnforcement) {
        historyArray.forEach((msg, idx) => {
            // Always protect the system prompt (idx 0), task definition, formal plan, and the very last turn
            const isCritical = idx === 0 || idx === taskIndex || idx === planIndex || idx === planIndex + 1 || idx >= historyArray.length - 2;
            if (!isCritical) { 
                if (msg.content && msg.content.length > TRIM_THRESHOLD) {
                    console.log(`Resource Manager: Trimming large message at index ${idx} (${msg.content.length} chars)`);
                    const keepSize = isActuallyCongested ? TRIM_THRESHOLD / 4 : TRIM_THRESHOLD / 2;
                    msg.content = msg.content.substring(0, keepSize) + 
                                  "\n\n... [TRUNCATED BY RESOURCE GUARD TO PRESERVE TASK CONTEXT] ...\n\n" + 
                                  msg.content.slice(- (keepSize / 2));
                }
            }
        });
    }

    // 2. Reduce history size if it exceeds MAX_LENGTH, preserving critical task flow
    if (needsStrictContextEnforcement && historyArray.length > MAX_LENGTH) {
        console.log(`Resource Manager: Pruning history from ${historyArray.length} to ${MAX_LENGTH} messages (Task-Aware).`);
        const systemPrompt = historyArray[0];
        const criticalIndices = new Set([0, taskIndex, planIndex, planIndex + 1].filter(idx => idx !== -1 && idx < historyArray.length));
        
        // Take as many recent messages as fit after critical ones
        const recentMessages = [];
        for (let i = historyArray.length - 1; i >= 0; i--) {
            if (recentMessages.length >= (MAX_LENGTH - criticalIndices.size)) break;
            if (!criticalIndices.has(i)) {
                recentMessages.unshift(historyArray[i]);
            }
        }
        
        const finalHistory = [systemPrompt];
        if (taskIndex !== -1 && taskIndex !== 0) finalHistory.push(historyArray[taskIndex]);
        if (planIndex !== -1 && planIndex !== 0 && planIndex !== taskIndex) {
            finalHistory.push(historyArray[planIndex]);
            if (planIndex + 1 < historyArray.length) finalHistory.push(historyArray[planIndex + 1]);
        }
        
        // Add recent ones that aren't already there
        recentMessages.forEach(m => {
            if (!finalHistory.includes(m)) finalHistory.push(m);
        });
        
        // Re-sort by original temporal order if needed, but here we just want a valid flow
        historyArray = finalHistory.sort((a, b) => historyArray.indexOf(a) - historyArray.indexOf(b));
    }

    // 3. Strict Payload Character Limit Enforcement (Prevents LM Studio Thrashing)
    if (uplinkMode.checked) {
        let currentChars = historyArray.reduce((acc, msg) => acc + (msg.content ? msg.content.length : 0), 0);
        if (currentChars > MAX_ALLOWED_CHARS) {
            console.warn(`[CONTEXT GUARD] Payload size (${currentChars} chars) exceeds optimal context window (${MAX_ALLOWED_CHARS} chars). Aggressively pruning intermediate messages...`);
            
            // Drop older intermediate messages until we fit, protecting system, task, and last turn
            while (currentChars > MAX_ALLOWED_CHARS && historyArray.length > 3) {
                let pruneIdx = 1;
                // Protect Task (idx 1) and Plan (idx 2) if they exist
                if (historyArray.length > 5) {
                    if (pruneIdx === 1) pruneIdx = 2; // Skip task
                    if (pruneIdx === 2 && planIndex !== -1) pruneIdx = 3; // Skip plan
                }
                
                if (pruneIdx >= historyArray.length - 1) pruneIdx = 1; // Fallback

                const removed = historyArray.splice(pruneIdx, 1)[0];
                currentChars -= (removed.content ? removed.content.length : 0);
            }
            
            // If it's still too big (e.g. the final prompt itself is massive), forcefully truncate the last messages
            if (currentChars > MAX_ALLOWED_CHARS) {
                const targetChars = MAX_ALLOWED_CHARS * 0.5; 
                while (currentChars > targetChars && historyArray.length > 4) {
                    const removed = historyArray.splice(1, 1)[0];
                    currentChars -= (removed.content ? removed.content.length : 0);
                }
                
                // Final emergency truncation of individual messages
                for (let i = historyArray.length - 1; i > 0; i--) {
                    if (currentChars <= MAX_ALLOWED_CHARS) break;
                    if (historyArray[i].content && historyArray[i].content.length > 1000) {
                        const overage = currentChars - MAX_ALLOWED_CHARS;
                        const newLength = Math.max(500, historyArray[i].content.length - overage);
                        historyArray[i].content = historyArray[i].content.substring(0, newLength) + "\n...[TRUNCATED]";
                        currentChars = historyArray.reduce((acc, msg) => acc + (msg.content ? msg.content.length : 0), 0);
                    }
                }
            }
        }
    }
    
    return historyArray;
}

// --- Main send logic (unified streaming) ---
class PipelineTrace { 
    constructor() { this._failed = false; } 
    addStep() {} 
    close() { return {}; } 
}
const compileExplanation = () => ({ summary: "GhostTrace disabled in this environment." });
const generateReport = () => {};

let isSending = false;

stopBtn.addEventListener('click', () => {
    if (abortController) {
        abortController.abort();
        addMessage('system', 'Neural link terminated.');
    }
});

async function sendMessage() {
    if (isSending) return;
    
    const trace = new PipelineTrace(null, null, `req_${Date.now()}`);
    trace.addStep('input.received', 'input', 'ok', 'INPUT_OK', 0);
    
    const text = userInput.value.trim();
    if (!text) return;
    
    const model = modelSelect.value;
    if (!model || model === "Scanning...") {
        trace.addStep('routing.selected_capability', 'routing', 'error', 'NO_MODEL', 0, 'No model selected');
        trace.close();
        addMessage('system', '**System Error:** No model selected. Please wait for model list or check connection.');
        return;
    }

    isSending = true;
    userInput.value = '';
    userInput.disabled = true;
    sendBtn.disabled = true;
    
    // Mobile reliable clear: force blur and small delay
    userInput.blur();
    setTimeout(() => { userInput.value = ''; }, 10);
    
    abortController = new AbortController();
    sendBtn.style.display = 'none';
    stopBtn.style.display = 'block';

    let finalPrompt = text;
    let images = [];

    if (attachedFiles.length > 0) {
        finalPrompt += "\n\n[ATTACHMENTS]:\n" + attachedFiles.map(f => {
            if (f.isImage) { images.push(f.base64); return `[IMAGE: ${f.fileName}]`; }
            return `--- ${f.fileName} ---\n${f.content}`;
        }).join('\n');
        attachedFiles = [];
        renderAttachments();
    }

    let transientMemoryContext = "";
    if (memoryToggle.checked) {
        const startMem = Date.now();
        try {
            // OPTIMIZATION: Embeddings are now forced to CPU in v31.3, so we no longer need to page out the main model.
            // This prevents the 'hang' caused by constant VRAM swapping.
            const mem = await searchMemory(text);
            
            trace.addStep('context.loaded', 'context', 'ok', 'MEM_LOADED', Date.now() - startMem);
            if (mem && mem.length > 0) {
                transientMemoryContext = "\n\n[READ-ONLY BACKGROUND DATABASE]\n" + mem.map(m => `- ${m.text}`).join('\n') + "\n(END OF READ-ONLY DATABASE. DO NOT re-save any of the above facts into memory. You MUST ONLY save completely new facts from the user's latest input.)";
            }
        } catch (err) {
            trace.addStep('context.loaded', 'context', 'error', 'MEM_FAIL', Date.now() - startMem, err.message);
            console.warn('Memory search failed/timed out:', err);
            addMessage('system', '**Neural-Core Warning:** Memory search failed.');
        }
    }

    const agentEnabled = document.getElementById('agent-toggle')?.checked;

    if (netrunnerToggle?.checked && !agentEnabled) {
        try {
            const searchResults = await window.api.invoke('perform-search', text);
            if (searchResults && !searchResults.error && searchResults.length > 0) {
                const webCtx = searchResults.map(r => `Source: ${r.title}. Details: ${r.snippet}`).join(' ');
                finalPrompt = `I need you to write a conversational news report based on the following web data.

CRITICAL INSTRUCTIONS:
- You must write this as a flowing, continuous essay consisting only of paragraphs.
- You must speak in the first person (e.g., "I discovered that...").
- Do NOT use bullet points. Do NOT use dashes. Do NOT use numbered lists. Do NOT use tables.

Web Data to use:
${webCtx}

My Query: ${text}`;
                const searchLog = document.createElement('div');
                searchLog.className = 'search-results-log';
                searchLog.innerHTML = `<strong>NETRUNNER:</strong> Found ${searchResults.length} results<ul>${searchResults.map(r => `<li><a href="${r.url}" target="_blank">${r.title}</a></li>`).join('')}</ul>`;
                messagesContainer.appendChild(searchLog);
            }
        } catch (e) { console.error('Netrunner search failed:', e); }
    }

    // OFFLINE WEB BROWSER MODE (v37.6)
    const isOfflineBrowserTurn = document.getElementById('offline-browser-toggle')?.checked;
    if (isOfflineBrowserTurn) {
        finalPrompt = `[OFFLINE WEB BROWSER MODE]
The user is requesting to browse or search for: "${text}"

Generate a complete, highly professional, and beautiful HTML5 webpage that fulfills this request. 

CRITICAL RULES:
1. Output ONLY raw HTML. No explanations, no markdown formatting, no \`\`\`html tags.
2. Start your response directly with <!DOCTYPE html>.
3. Include embedded CSS (<style>) to make the page visually stunning, modern, and perfectly responsive (use max-width: 100% and word-wrap: break-word).
4. If it's an informational query, theme it like a high-quality Wiki or sleek modern article.
5. Ensure you define a background color and text colors in your CSS (e.g., body { background: #ffffff; color: #333333; font-family: sans-serif; }).`;
    }

    addMessage('user', text);
    chatHistory.push({ role: 'user', content: finalPrompt, ...(images.length > 0 ? { images } : {}) });

    const botDiv = addMessage('bot', '');
    if (isOfflineBrowserTurn) {
        botDiv.style.maxWidth = '100%';
        botDiv.style.width = '100%';
        botDiv.style.padding = '0';
        botDiv.style.overflowX = 'auto';
        botDiv.style.overflowY = 'hidden';
        botDiv.style.backgroundColor = '#ffffff'; // Fallback if model forgets CSS
        botDiv.style.minHeight = '400px';
        botDiv.style.borderRadius = '8px';
        botDiv.style.border = '1px solid var(--border-color)';
        const shadow = botDiv.attachShadow({mode: 'open'});
        shadow.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-family: sans-serif;">Connecting to Local Server...</div>`;
    } else {
        botDiv.innerHTML = '<span class="loading-pulse">Thinking...</span>';
    }

    try {
        // SPEED OPTIMIZATION: Check if system prompt exists, otherwise create it with stronger memory directives
        if (!chatHistory || chatHistory.length === 0 || chatHistory[0].role !== 'system') {
            let envContext = "";
            try {
                const envInfo = await window.api.invoke('get-env-info');
                if (envInfo && !envInfo.error) {
                    envContext = `\n\n[SYSTEM ENVIRONMENT]:\nOS: ${envInfo.platform} (${envInfo.arch})\nUser: ${envInfo.username}\nHome Dir: ${envInfo.homedir}\nCurrent Dir: ${envInfo.cwd}\n`;
                }
            } catch (e) {}
            
            const systemPrompt = `You are Xkaliber Agent v39.4, a conversational AI assistant (AMD Optimized). You have access to persistent vector memory, web search, and system tools. Respond naturally and conversationally to the user. Do not invoke tools for casual conversation or greetings.

AUTONOMOUS WORKFLOW:
You support a 'Plan-Execute-Verify' loop. For complex requests (especially file system tasks):
1. Use \`task_begin\` to state your goal and a multi-step plan.
2. Execute the steps sequentially using appropriate tools.
3. After each step, analyze the output and decide the next action.
4. Once finished, use \`task_complete\` to summarize and verify the results before responding to the user.

CRITICAL: If you are asked to modify, create, or read files, you MUST use the provided tools (write_file, read_file, run_shell_command) immediately. Do not hesitate.

GUARD RAILS:
1. SECURE ACCESS: This version (v39.4) includes secure login and account creation. Access is restricted to authorized users only.
2. STRICT ACTION LIMITS: Never use file modification tools unless explicitly requested by the user. If the user asks to download a file, ALWAYS use the provide_file_download_link tool. 
3. NO UNPROMPTED SETUP: Do not set up configuration files or scripts unprompted. If you are asked to read or list files, do not follow up with write actions. 
4. PREVENT HALLUCINATIONS: If you are unsure of the user's intent or lack context, DO NOT guess or hallucinate a tool call. Instead, ask the user for clarification.

WEB SEARCH GUIDELINES:
When you use the web_search tool, you must provide the findings to the user as clean, natural language. Explain the information from a first-person perspective (e.g., 'I found that...'). Avoid using bullet points, numbered lists, or cluttered responses. Instead, present the search results as a cohesive, conversational narrative.

MEMORY DIRECTIVES:
You have a tool called save_new_user_fact_only. You must be EXTREMELY SELECTIVE with this tool.
- DO NOT save casual conversation, greetings, or temporary thoughts.
- ONLY save permanent, highly important facts (e.g., "I am allergic to peanuts", "My favorite color is blue", "I work as a software engineer").
- NEVER save a fact that was already saved or discussed in previous messages.
- If the user says something trivial, just chat with them normally and DO NOT use the memory tool.${envContext}`;
            if (!chatHistory) chatHistory = [];
            chatHistory.unshift({ role: "system", content: systemPrompt });
        }

        // --- BUG FIX FOR PAYLOAD CLONING ---
        // Now that chatHistory has both the system prompt AND the new user prompt,
        // we can safely clone it into payloadHistory so the AI actually sees the instruction.
        let payloadHistory = JSON.parse(JSON.stringify(chatHistory));

        // TASK ISOLATION (v37.5/v38.1): To prevent context bloating and VRAM exhaustion during heavy coding tasks,
        // we proactively flush older chat history from the model's memory if Resource Saver is ON or system is congested.
        const memorySaverEnabled = document.getElementById('memory-saver-toggle')?.checked;
        const isActuallyCongested = currentResourceStatus === 'congested';
        
        if (memorySaverEnabled || isActuallyCongested) {
            console.log(`[RESOURCE GUARD] Task Isolation triggered (${isActuallyCongested ? 'CONGESTED' : 'MANUAL'}). Flushing previous conversational context.`);
            if (payloadHistory && payloadHistory.length > 0 && payloadHistory[0].role === 'system') {
                const sysPrompt = payloadHistory[0];
                const lastUserPrompt = payloadHistory[payloadHistory.length - 1]; // The prompt we just added
                
                // Identify the ORIGINAL task if it's different from the last user prompt
                // This ensures the agent never forgets what it was originally asked to do.
                let originalTask = null;
                for (let i = chatHistory.length - 2; i >= 1; i--) {
                    if (chatHistory[i].role === 'user') {
                        originalTask = chatHistory[i];
                        break;
                    }
                }
                
                if (originalTask && originalTask !== lastUserPrompt) {
                    payloadHistory = [sysPrompt, originalTask, lastUserPrompt];
                } else {
                    payloadHistory = [sysPrompt, lastUserPrompt]; 
                }
            } else {
                payloadHistory = [];
            }
        }

        console.log(`Connecting to Uplink at ${currentApiBase}...`);
        let finished = false;
        let turnCount = 0;
        const maxSteps = parseInt(stepsSlider?.value || "20");
        
        trace.addStep('routing.selected_capability', 'routing', 'ok', 'ROUTE_OK', 0, model);

        while (!finished && turnCount < maxSteps) {
            turnCount++;
            
            // RESOURCE OPTIMIZATION: Prune history if needed before each turn, passing turnCount
            payloadHistory = pruneChatHistory(payloadHistory, false, turnCount);

            let body, endpoint;
            
            // Provide visual feedback for the current step
            if (turnCount > 1) {
                 botDiv.innerHTML = `<span class="loading-pulse">Thinking (Step ${turnCount}/${maxSteps})...</span>`;
            }
            
            let activeTools = [];
            if (agentEnabled) {
                activeTools = AGENT_TOOLS;
            } else if (memoryToggle?.checked) {
                activeTools = AGENT_TOOLS.filter(t => t.function.name === 'save_new_user_fact_only' || t.function.name === 'memory_search');
            }

            if (uplinkMode.checked) {
                // LM Studio / OpenAI Format
                endpoint = `${currentApiBase}/v1/chat/completions`;
                
                const messages = [];
                const pendingToolCalls = []; 

                for (let i = 0; i < payloadHistory.length; i++) {
                    const m = payloadHistory[i];
                    if (!m.role) continue;

                    let msg = { role: m.role };

                    if (m.role === 'system') {
                        msg.content = String(m.content || "You are a helpful assistant.");
                        if (transientMemoryContext) {
                            msg.content += transientMemoryContext;
                        }
                        const currentDate = new Date().toLocaleString();
                        msg.content += `\n\n[SYSTEM CLOCK] The current host date and time is: ${currentDate}. Always use this exact time when asked.`;
                    } 
                    else if (m.role === 'user') {
                        msg.content = String(m.content || "");

                        if (m.images && m.images.length > 0) {
                            msg.content = [
                                { type: "text", text: msg.content },
                                ...m.images.map(img => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${img}` } }))
                            ];
                        }
                    } 
                    else if (m.role === 'assistant') {
                        // Ensure content is at least an empty string if tool_calls exist, some models fail on null
                        msg.content = (m.content && m.content.trim()) ? String(m.content) : "";
                        
                        if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                            msg.tool_calls = m.tool_calls.map(tc => {
                                // Preserve ID if it exists in history, otherwise generate once
                                if (!tc.id) tc.id = `call_${Math.random().toString(36).substring(2, 10)}`;
                                return {
                                    id: tc.id,
                                    type: 'function',
                                    function: {
                                        name: tc.function?.name || 'unknown_function',
                                        arguments: typeof tc.function?.arguments === 'string' 
                                            ? tc.function.arguments 
                                            : JSON.stringify(tc.function?.arguments || {})
                                    }
                                };
                            });
                        } else if (!msg.content) {
                            // Assistant message must have content or tool_calls
                            continue; 
                        }
                    } 
                    else if (m.role === 'tool' || m.role === 'function') {
                        msg.role = 'tool';
                        msg.content = String(m.content || "Success");
                        msg.tool_call_id = m.tool_call_id || `call_${Math.random().toString(36).substring(2, 10)}`;
                        if (m.name) msg.name = m.name;
                    }

                    messages.push(msg);
                }

                if (messages.length === 0) {
                    messages.push({ role: 'user', content: finalPrompt });
                }

                body = {
                    model,
                    messages,
                    stream: true,
                    temperature: (tempSlider && !isNaN(parseFloat(tempSlider.value))) ? parseFloat(tempSlider.value) : 0.7,
                    max_tokens: -1
                };
                
                // LM Studio strictly enforces tool payload schemas
                if (activeTools.length > 0) {
                    body.tools = activeTools.map(t => ({
                        type: "function",
                        function: {
                            name: t.function.name,
                            description: t.function.description || "",
                            parameters: t.function.parameters || { type: "object", properties: {} }
                        }
                    }));
                }
            } else {
                // Ollama Format
                endpoint = `${currentApiBase}/chat`;
                
                // Deep copy chatHistory to inject transient context
                const messagesForOllama = payloadHistory.map(m => {
                    let msg = { role: m.role, content: m.content || "" };
                    if (m.role === 'tool' || m.role === 'function') {
                        msg.role = 'tool';
                        if (m.name) msg.name = m.name;
                        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
                    }
                    if (m.images) msg.images = m.images;
                    if (m.role === 'assistant' && m.tool_calls) {
                        msg.tool_calls = m.tool_calls.map(tc => ({
                            function: {
                                name: tc.function.name,
                                arguments: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments
                            }
                        }));
                    }
                    return msg;
                });

                if (messagesForOllama.length > 0) {
                    const systemIdx = messagesForOllama.findIndex(m => m.role === 'system');
                    if (systemIdx !== -1) {
                        if (transientMemoryContext) {
                            messagesForOllama[systemIdx].content += transientMemoryContext;
                        }
                        const currentDate = new Date().toLocaleString();
                        messagesForOllama[systemIdx].content += `\n\n[SYSTEM CLOCK] The current host date and time is: ${currentDate}. Always use this exact time when asked.`;
                    }
                }

                const memorySaverEnabled = document.getElementById('memory-saver-toggle')?.checked;
                // Protect the model in VRAM during active generation to prevent it from being flushed
                // if a tool execution (like compiling) takes longer than the keep_alive timeout.
                body = {
                    model,
                    messages: messagesForOllama,
                    stream: true,
                    options: { temperature: parseFloat(tempSlider.value), num_ctx: parseInt(ctxSlider.value) },
                    keep_alive: -1 // Keep locked in VRAM while the task is ongoing
                };
                if (activeTools.length > 0) body.tools = activeTools;
            }

            const startGen = Date.now();
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer lm-studio'
                },
                body: JSON.stringify(body),
                signal: abortController.signal
            });

            if (!res.ok) {
                const errorText = await res.text();
                console.error("Payload that failed:", JSON.stringify(body, null, 2));
                trace.addStep('inference.generate', 'inference', 'error', 'API_HTTP_ERR', Date.now() - startGen, errorText);
                throw new Error(`Uplink Error (${res.status}): ${errorText || res.statusText}`);
            }

            trace.addStep('inference.generate', 'inference', 'ok', 'GEN_OK', Date.now() - startGen);
            console.log("Neural link established. Receiving stream...");

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let toolCalls = null;
            // Provide visual feedback for the current step while keeping previous output
            const existingText = botDiv.innerHTML.replace(/<span class="loading-pulse">.*?<\/span><br><br>/g, '').trim();
            if (existingText && !existingText.includes('Thinking...')) {
                 botDiv.innerHTML = `<span class="loading-pulse">Thinking (Step ${turnCount}/${maxSteps})...</span><br><br>${existingText}`;
            } else {
                 botDiv.innerHTML = `<span class="loading-pulse">Thinking (Step ${turnCount}/${maxSteps})...</span>`;
            }

            const readWithTimeout = (reader, timeoutMs) => {
                return new Promise((resolve, reject) => {
                    const timeoutId = setTimeout(() => reject(new Error('Stream timeout: Uplink is hung. VRAM may be heavily congested.')), timeoutMs);
                    reader.read().then((result) => {
                        clearTimeout(timeoutId);
                        resolve(result);
                    }).catch(err => {
                        clearTimeout(timeoutId);
                        reject(err);
                    });
                });
            };

            let leftover = '';
            let isFirstChunk = true;
            let finishReason = null;
            while (true) {
                // Increase timeout significantly for the first chunk to allow for model reloading/context processing after a VRAM flush.
                // 15 minutes for the first chunk, 5 minutes for subsequent chunks.
                const currentTimeoutMs = isFirstChunk ? 900000 : 300000; 
                
                if (isFirstChunk) {
                    botDiv.innerHTML = `<span class="loading-pulse" style="color: var(--warning-color)">Warming up model and processing context... (This may take a moment after a resource flush)</span><br><br>${existingText}`;
                }

                const { done, value } = await readWithTimeout(reader, currentTimeoutMs);
                isFirstChunk = false;
                
                if (done) break;
                
                const chunk = decoder.decode(value);
                const lines = (leftover + chunk).split('\n');
                leftover = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    if (uplinkMode.checked) {
                        // OpenAI / LM Studio Format: "data: {...}"
                        if (trimmed === 'data: [DONE]') continue;
                        if (trimmed.startsWith('data:')) {
                            try {
                                const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
                                const json = JSON.parse(jsonStr);
                                const delta = json.choices?.[0]?.delta;
                                if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
                                if (delta?.content) {
                                    fullContent += delta.content;
                                    // Strip leaked thought tags from UI rendering
                                    fullContent = fullContent.replace(/<\|channel>.*?<channel\|>/gs, '').replace(/<\|.*?\|>/gs, '');
                                    if (isOfflineBrowserTurn) {
                                        let cleanHtml = fullContent.replace(/^```html\n?/i, '').replace(/\n?```$/i, '');
                                        const baseWebStyles = `<style>:host { display: block; max-width: 100%; overflow-x: auto; } body { word-wrap: break-word; overflow-wrap: break-word; max-width: 100%; box-sizing: border-box; } *, *::before, *::after { box-sizing: border-box; max-width: 100%; } img, video, iframe, canvas { max-width: 100%; height: auto; } pre, code, table { max-width: 100%; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; }</style>`;
                                        botDiv.shadowRoot.innerHTML = baseWebStyles + cleanHtml;
                                    } else {
                                        botDiv.innerHTML = `<span class="loading-pulse">Thinking (Step ${turnCount}/${maxSteps})...</span><br><br>${existingText ? existingText + '<br><br>' : ''}${window.markedParse(fullContent)}`;
                                    }
                                }
                                if (delta?.tool_calls) {
                                    if (!toolCalls) toolCalls = [];
                                    delta.tool_calls.forEach(tc => {
                                        const idx = tc.index;
                                        if (idx !== undefined) {
                                            if (!toolCalls[idx]) {
                                                toolCalls[idx] = tc;
                                                if (!toolCalls[idx].id) toolCalls[idx].id = `call_${Math.random().toString(36).substring(2, 10)}`;
                                                if (toolCalls[idx].function && !toolCalls[idx].function.arguments) {
                                                    toolCalls[idx].function.arguments = '';
                                                }
                                            } else {
                                                if (tc.function?.arguments) {
                                                    toolCalls[idx].function.arguments += tc.function.arguments;
                                                }
                                                if (tc.id) toolCalls[idx].id = tc.id;
                                                if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
                                            }
                                        }
                                    });
                                }
                            } catch (e) { console.warn('Failed to parse LMS chunk:', trimmed, e); }
                        }
                    } else {
                        // Ollama Format
                        try {
                            const json = JSON.parse(trimmed);
                            if (json.error) {
                                throw new Error(`Ollama Error: ${json.error}`);
                            }
                            if (json.done_reason) finishReason = json.done_reason;
                            
                            // Support both /api/chat and /api/generate formats
                            let contentDelta = "";
                            if (json.message && typeof json.message.content === 'string') {
                                contentDelta = json.message.content;
                            } else if (typeof json.response === 'string') {
                                contentDelta = json.response;
                            }

                            if (contentDelta) {
                                fullContent += contentDelta;
                                // Strip leaked thought tags from UI rendering
                                fullContent = fullContent.replace(/<\|channel>.*?<channel\|>/gs, '').replace(/<\|.*?\|>/gs, '');
                                if (isOfflineBrowserTurn) {
                                    let cleanHtml = fullContent.replace(/^```html\n?/i, '').replace(/\n?```$/i, '');
                                    const baseWebStyles = `<style>:host { display: block; max-width: 100%; overflow-x: auto; } body { word-wrap: break-word; overflow-wrap: break-word; max-width: 100%; box-sizing: border-box; } *, *::before, *::after { box-sizing: border-box; max-width: 100%; } img, video, iframe, canvas { max-width: 100%; height: auto; } pre, code, table { max-width: 100%; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; }</style>`;
                                    botDiv.shadowRoot.innerHTML = baseWebStyles + cleanHtml;
                                } else {
                                    botDiv.innerHTML = `<span class="loading-pulse">Thinking (Step ${turnCount}/${maxSteps})...</span><br><br>${existingText ? existingText + '<br><br>' : ''}${window.markedParse(fullContent)}`;
                                }
                            }
                            // V38: Better tool call handling for Ollama - append instead of overwrite
                            if (json.message?.tool_calls?.length > 0) {
                                if (!toolCalls) toolCalls = [];
                                json.message.tool_calls.forEach(tc => {
                                    if (!tc.id) tc.id = `call_${Math.random().toString(36).substring(2, 10)}`;
                                    // Check if this tool call already exists (avoid duplicates in some streaming modes)
                                    const exists = toolCalls.some(existing => existing.id === tc.id || (existing.function.name === tc.function.name && JSON.stringify(existing.function.arguments) === JSON.stringify(tc.function.arguments)));
                                    if (!exists) toolCalls.push(tc);
                                });
                            }
                        } catch (e) { console.warn('Failed to parse Ollama chunk:', trimmed, e); }
                    }
                }
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }

            if (finishReason === 'length') {
                console.warn("[GUARD RAIL] Generation cut off due to context limits.");
                botDiv.innerHTML += `<br><br><span style="color:var(--danger-color); padding: 5px; border: 1px dashed var(--danger-color); border-radius: 4px; display: inline-block; margin-top: 10px; font-size: 0.85rem;"><strong>⚠️ RESOURCE GUARD:</strong> The model hit its context limit during generation. Attempting ultra-aggressive memory wipe to recover and continue...</span>`;
                
                chatHistory.push({ role: 'assistant', content: fullContent });
                payloadHistory.push({ role: 'assistant', content: fullContent });
                
                // Force an ultra-aggressive prune right now to clear up space for the next turn
                payloadHistory = pruneChatHistory(payloadHistory, true, 99); 
                
                // Tell the agent it was cut off so it knows its previous response is incomplete
                const recoveryMsg = "[SYSTEM ALARM]: Your previous generation was cut off mid-thought because you exceeded the context window limit (max tokens reached). If you were writing a large file, it failed. Please plan a new strategy using smaller chunks, or summarize your progress and stop.";
                chatHistory.push({ role: 'user', content: recoveryMsg });
                payloadHistory.push({ role: 'user', content: recoveryMsg });
                
                // Continue the loop instead of breaking, giving the agent a chance to recover with a clear context!
                continue;
            }

            if (toolCalls?.length > 0) {
                // For OpenAI format, tool_calls arguments might be strings that need parsing
                toolCalls = toolCalls.map(tc => {
                    if (typeof tc.function.arguments === 'string') {
                        try {
                            tc.function.arguments = JSON.parse(tc.function.arguments);
                        } catch (e) { console.warn('Failed to parse tool arguments:', tc.function.arguments); }
                    }
                    return tc;
                });

                // --- V29 GUARD RAILS: Validation ---
                let validToolCalls = [];
                let hallucinations = [];

                for (const tc of toolCalls) {
                    const toolName = tc.function?.name;
                    const toolExists = activeTools.some(t => t.function.name === toolName);
                    
                    if (!toolExists) {
                        console.warn(`Hallucination detected: Tool "${toolName}" does not exist.`);
                        hallucinations.push(`Unknown tool: ${toolName}`);
                        continue;
                    }

                    // Simple argument check - if it's supposed to be an object but isn't
                    if (!tc.function.arguments || typeof tc.function.arguments !== 'object') {
                         console.warn(`Hallucination detected: Tool "${toolName}" has invalid arguments.`);
                         hallucinations.push(`Invalid arguments for ${toolName}`);
                         continue;
                    }

                    validToolCalls.push(tc);
                }

                if (hallucinations.length > 0) {
                    console.log("Blocking suspected hallucination and asking for clarification...");
                    chatHistory.push({ role: 'assistant', content: fullContent || "I attempted to perform a task but got confused." });
                    payloadHistory.push({ role: 'assistant', content: fullContent || "I attempted to perform a task but got confused." });
                    chatHistory.push({ role: 'user', content: `[GUARD RAIL]: I noticed you tried to use tools that don't exist or provided invalid parameters: ${hallucinations.join(', ')}. If you are unsure of how to proceed, please ask me for clarification instead of guessing.` });
                    payloadHistory.push({ role: 'user', content: `[GUARD RAIL]: I noticed you tried to use tools that don't exist or provided invalid parameters: ${hallucinations.join(', ')}. If you are unsure of how to proceed, please ask me for clarification instead of guessing.` });
                    botDiv.innerHTML = window.markedParse(fullContent + "\n\n*(Neural-Core intercepted a suspected hallucination. Nudging model for clarification...)*");
                    continue; 
                }

                // Anti-looping guard
                const currentSig = JSON.stringify(validToolCalls.map(t => ({ name: t.function?.name, args: t.function?.arguments })));
                if (window._lastToolCallSignature === currentSig && turnCount > 1) {
                    console.warn("Tool loop detected! Model generated exact same tool call. Nudging.");
                    chatHistory.push({ role: 'user', content: "You just requested the exact same tool call again. Please use the results already provided above to answer the user's question directly." });
                    payloadHistory.push({ role: 'user', content: "You just requested the exact same tool call again. Please use the results already provided above to answer the user's question directly." });
                    continue; 
                }
                window._lastToolCallSignature = currentSig;

                const apiToolCalls = validToolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments) } }));
                chatHistory.push({ role: 'assistant', content: fullContent, tool_calls: apiToolCalls });
                payloadHistory.push({ role: 'assistant', content: fullContent, tool_calls: apiToolCalls });

                // OPTIMIZATION: Memory tools (mem_store, memory_search) now run on CPU in v31.3.
                // We no longer need to page out the main model here, saving significant time.

                for (const t of validToolCalls) {
                    const logDiv = document.createElement('div');
                    logDiv.className = 'agent-log';
                    logDiv.textContent = `⚡ Exec: ${t.function.name}\nArgs: ${JSON.stringify(t.function.arguments, null, 2)}`;
                    messagesContainer.insertBefore(logDiv, botDiv);

                    let result;
                    const startTool = Date.now();
                    try {
                        result = await executeTool(t.function.name, t.function.arguments);
                        trace.addStep('tools.execute', 'tools', 'ok', 'TOOL_OK', Date.now() - startTool, t.function.name, t.function.name);
                    } catch (e) {
                        result = `Error: ${e.message}`;
                        trace.addStep('tools.execute', 'tools', 'error', 'TOOL_ERR', Date.now() - startTool, e.message, t.function.name);
                    }
                    chatHistory.push({ role: 'tool', name: t.function.name, content: String(result), tool_call_id: t.id });
                    payloadHistory.push({ role: 'tool', name: t.function.name, content: String(result), tool_call_id: t.id });
                }
                if (isOfflineBrowserTurn) {
                     botDiv.shadowRoot.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-family: sans-serif;">Applying tool results (Step ${turnCount})...</div>`;
                } else {
                     botDiv.innerHTML = `<span class="loading-pulse">Step ${turnCount} complete. Thinking...</span><br><br>${existingText ? existingText + '<br><br>' : ''}${window.markedParse(fullContent)}`;
                }
                await new Promise(r => setTimeout(r, 1500)); // Increased VRAM relief delay
                continue; // V38 FIX: Ensure loop restarts to send tool results back to the model
            } else {
                window._lastToolCallSignature = null; // Clear on success
                // BUG FIX: If model is silent after tool results, nudge it.
                if (turnCount > 1 && (!fullContent || fullContent.trim().length < 2)) {
                    console.log("Neural link active but model is silent after tool results. Nudging for final response...");
                    chatHistory.push({ role: 'user', content: "Please summarize the results above and provide the final answer." });
                    payloadHistory.push({ role: 'user', content: "Please summarize the results above and provide the final answer." });
                    continue; 
                }

                chatHistory.push({ role: 'assistant', content: fullContent });
                payloadHistory.push({ role: 'assistant', content: fullContent });
                window.api.invoke('save-history', chatHistory);
                
                botDiv.innerHTML = `${existingText ? existingText + '<br><br>' : ''}${window.markedParse(fullContent)}`;
                
                if (fullContent) {
                    const cleanText = stripMarkdown(fullContent);
                    if (localTtsToggle?.checked) {
                        localSpeak(cleanText);
                    } else if (ttsToggle?.checked) {
                        window.api.send('tts-speak', cleanText);
                    }
                }
                
                finished = true;
                
                trace.addStep('output.finalize', 'output', 'ok', 'DONE', 0);
            }
        }
        
        trace.close();
        if (trace._failed) {
            const explanation = compileExplanation(trace);
            generateReport(trace, explanation, text, fullContent);
        }
        
    } catch (e) {
        if (e.name === 'AbortError') {
            botDiv.innerHTML = `<span style="color:#ff4444">Error: Request aborted by user.</span>`;
            // Remove the user message we just added since it was cancelled
            if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'user') {
                chatHistory.pop();
            }
            trace.addStep('inference.generate', 'inference', 'aborted', 'USER_ABORT', 0, 'User stopped generation');
        } else if (e.message.includes('timeout')) {
            botDiv.innerHTML = `<span style="color:#ff4444">Error: Model timed out. VRAM may be heavily congested. Try clearing memory or restarting Ollama.</span>`;
            trace.addStep('inference.generate', 'inference', 'timeout', 'REQ_TIMEOUT', 0, e.message);
        } else {
            botDiv.innerHTML = `<span style="color:#ff4444">Error: ${e.message}</span>`;
            trace.addStep('inference.generate', 'inference', 'error', 'EXEC_ERR', 0, e.message);
        }
        
        trace.close();
        const explanation = compileExplanation(trace);
        generateReport(trace, explanation, text, "");
        
    } finally {
        isSending = false; // Release the VRAM paging lock
        
        // Now that the task is fully finished, apply the requested memory saving policy
        const memorySaverEnabled = document.getElementById('memory-saver-toggle')?.checked;
        if (memorySaverEnabled && !uplinkMode.checked) {
            const currentModel = modelSelect.value;
            if (currentModel) {
                // Background fetch to reset keep_alive to 1m
                fetch(`${OLLAMA_API}/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: currentModel, messages: [], keep_alive: "1m" })
                }).catch(() => {});
            }
        }
        
        sendBtn.style.display = 'block';
        stopBtn.style.display = 'none';
        abortController = null;
        userInput.disabled = false;
        sendBtn.disabled = false;
        // Focus back to input on desktop
        if (!isWebMode) userInput.focus();
    }
}

sendBtn.addEventListener('click', sendMessage);
userInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
checkAuth();


// Intercept download links to append auth token and prevent UI crash
document.addEventListener('click', (e) => {
    const target = e.target.closest('a');
    if (target && target.getAttribute('href')?.startsWith('/download_remote')) {
        e.preventDefault();
        const token = localStorage.getItem('auth_token');
        let url = target.getAttribute('href');
        if (token) {
            url += url.includes('?') ? `&token=${token}` : `?token=${token}`;
        }
        
        // If we are in Electron, use the host to open it safely in the default browser or trigger download
        if (!isWebMode) {
            window.api.invoke('get-host-url').then(hostInfo => {
                if (hostInfo && hostInfo.url) {
                    const fullUrl = hostInfo.url + url;
                    window.api.invoke('open-external-url', fullUrl);
                }
            });
        } else {
            // In web mode, just navigate (it's safe in a real browser as it triggers a download)
            window.location.href = url;
        }
    }
});
