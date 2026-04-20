// DOM Elements
const modelSelect = document.getElementById('model-select');
const tempSlider = document.getElementById('temp-slider');
const tempVal = document.getElementById('temp-val');
const ctxSlider = document.getElementById('ctx-slider');
const ctxVal = document.getElementById('ctx-val');
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
const testAudioBtn = document.getElementById('test-audio-btn');
const netrunnerToggle = document.getElementById('netrunner-toggle');
const exportBtn = document.getElementById('export-btn');
const importBtn = document.getElementById('import-btn');

const OLLAMA_API = 'http://localhost:11434/api';

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
        window.api.send('tts-speak', 'Xkaliber Agent audio uplink is operational.');
    });
}

window.api.on('tts-error', (msg) => addMessage('system', `**TTS Error:** ${msg}`));

// --- Attachment Handling ---
if (attachBtn) {
    attachBtn.addEventListener('click', async () => {
        const file = await window.api.invoke('open-file-dialog');
        if (file && !file.error) {
            attachedFiles.push(file);
            renderAttachments();
        } else if (file?.error) {
            addMessage('system', `**ATTACHMENT ERROR**: ${file.error}`);
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
[tempSlider, ctxSlider].forEach(s => s && s.addEventListener('input', () => {
    if (tempVal) tempVal.textContent = parseFloat(tempSlider.value).toFixed(1);
    if (ctxVal) ctxVal.textContent = ctxSlider.value;
}));

// --- Agent Tool Definitions ---
const AGENT_TOOLS = [
    {
        type: "function",
        function: {
            name: "run_shell_command",
            description: "Execute a bash shell command. If sudo is needed, it will be automatically handled using provided credentials.",
            parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
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
            description: "List contents of a directory.",
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
            name: "mem_store",
            description: "Store a fact, detail, or important information about the user or project into your long-term persistent memory.",
            parameters: { type: "object", properties: { text: { type: "string", description: "The specific detail or fact to remember." } }, required: ["text"] }
        }
    },
    {
        type: "function",
        function: {
            name: "memory_search",
            description: "Search long-term vector memory for past learned knowledge.",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
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
    }
];

// --- Memory helpers ---
async function pageOutModel(modelName) {
    if (!modelName) return;
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
        const count = await window.api.invoke('mem-count');
        memoryCountBadge.textContent = `[${count} MEMS]`;
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
    const res = await window.api.invoke('mem-query', { query, limit: 3 });
    if (res?.success) return res.data.filter(r => r.similarity > 0.3);
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
async function init() {
    try {
        await fetchModels();
        checkConnection();
        chatHistory = await window.api.invoke('load-history');
        if (!chatHistory || chatHistory.length === 0) {
            chatHistory = [{ role: "system", content: "You are Xkaliber Agent v21. You have access to dynamic schemas, robust vector memory, and system controls. Sudo is handled implicitly if a password is provided by the user. IMPORTANT: Use the `mem_store` tool to explicitly save important facts, preferences, or details about the user or project into your persistent memory. Do not assume information is saved unless you explicitly use the tool." }];
        }
        if (chatHistory.length > 0) renderHistory();
        updateMemoryCount();
    } catch (err) {
        setStatus(false, 'OFFLINE');
    }
}

async function fetchModels() {
    const res = await fetch(`${OLLAMA_API}/tags`);
    const data = await res.json();
    modelSelect.innerHTML = data.models.map(m => `<option value="${m.name}">${m.name}</option>`).join('');
}

function setStatus(online, text) {
    statusText.textContent = text;
    statusDot.className = `dot ${online ? 'connected' : ''}`;
    userInput.disabled = !online;
    sendBtn.disabled = !online;
}

function checkConnection() {
    fetch(`${OLLAMA_API}/tags`)
        .then(r => setStatus(r.ok, r.ok ? 'ONLINE' : 'OFFLINE'))
        .catch(() => setStatus(false, 'OFFLINE'));
}
setInterval(checkConnection, 5000);

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
    if (name === 'run_shell_command') {
        let cmd = args.command;
        const sudoPass = sudoInput.value;
        if (cmd.includes('sudo') && sudoPass) {
            cmd = cmd.replace(/sudo\s+/g, `echo "${sudoPass}" | sudo -S `);
        }
        const res = await window.api.invoke('agent-run-command', cmd);
        let out = "";
        if (res.error) out += `Error: ${res.error}\n`;
        if (res.stderr) out += `Stderr: ${res.stderr}\n`;
        if (res.stdout) out += `Stdout:\n${res.stdout}`;
        return out || "Success";
    }
    if (name === 'read_file') return (await window.api.invoke('agent-read-file', args.filepath)).content || "Error reading";
    if (name === 'write_file') return (await window.api.invoke('agent-write-file', args.filepath, args.content)).success ? "Success" : "Error";
    if (name === 'list_directory') return (await window.api.invoke('agent-list-directory', args.dirpath)).files || "Error";
    if (name === 'delete_file') return (await window.api.invoke('agent-delete-file', args.filepath)).success ? "Success" : "Error";
    if (name === 'mem_store') {
        const res = await saveToMemory(args.text);
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
    if (name === 'web_search') return JSON.stringify(await window.api.invoke('perform-search', args.query));
    if (name === 'send_whatsapp_message') return (await window.api.invoke('whatsapp-send', { number: args.number, message: args.message })).success ? "Success" : "Error";
    return `Unknown tool: ${name}`;
}

function stripMarkdown(text) {
    return text.replace(/[#*`_~\[\]()>]/g, '');
}

// --- Main send logic (unified streaming) ---
stopBtn.addEventListener('click', () => {
    if (abortController) {
        abortController.abort();
        addMessage('system', 'Neural link terminated.');
    }
});

async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;
    const model = modelSelect.value;
    userInput.value = '';
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

    if (memoryToggle.checked) {
        try {
            await pageOutModel(model); // PAGING: Page out Chat Model so Embed Model has VRAM for search
            const mem = await searchMemory(text);
            if (mem.length > 0) finalPrompt += "\n\n[MEMORY]:\n" + mem.map(m => `- ${m.text}`).join('\n');
        } catch (err) {
            console.warn('Memory search failed/timed out:', err);
            addMessage('system', '**Neural-Core Warning:** Memory search failed.');
        }
    }

    const agentEnabled = document.getElementById('agent-toggle')?.checked;

    if (netrunnerToggle?.checked && !agentEnabled) {
        try {
            const searchResults = await window.api.invoke('perform-search', text);
            if (searchResults && !searchResults.error && searchResults.length > 0) {
                const webCtx = searchResults.map(r => `- ${r.title}: ${r.snippet} (${r.url})`).join('\n');
                finalPrompt += "\n\n[WEB SEARCH RESULTS]:\n" + webCtx;
                const searchLog = document.createElement('div');
                searchLog.className = 'search-results-log';
                searchLog.innerHTML = `<strong>NETRUNNER:</strong> Found ${searchResults.length} results<ul>${searchResults.map(r => `<li><a href="${r.url}" target="_blank">${r.title}</a></li>`).join('')}</ul>`;
                messagesContainer.appendChild(searchLog);
            }
        } catch (e) { console.error('Netrunner search failed:', e); }
    }

    addMessage('user', text);
    chatHistory.push({ role: 'user', content: finalPrompt, ...(images.length > 0 ? { images } : {}) });

    const botDiv = addMessage('bot', '<span class="loading-pulse">Thinking...</span>');

    try {
        await pageOutModel('all-minilm'); // PAGING: Just in case, explicitly clear embed model before chat starts

        console.log(`Connecting to Ollama at ${OLLAMA_API}/chat...`);
        let finished = false;
        while (!finished) {
            const body = {
                model,
                messages: chatHistory,
                stream: true,
                options: { temperature: parseFloat(tempSlider.value), num_ctx: parseInt(ctxSlider.value) }
            };
            if (agentEnabled) body.tools = AGENT_TOOLS;

            const res = await fetch(`${OLLAMA_API}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: abortController.signal
            });

            if (!res.ok) {
                const errorText = await res.text();
                throw new Error(`Ollama Error (${res.status}): ${errorText || res.statusText}`);
            }

            console.log("Neural link established. Receiving stream...");

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let toolCalls = null;
            botDiv.innerHTML = '';

            const readWithTimeout = (reader, timeoutMs) => {
                return new Promise((resolve, reject) => {
                    const timeoutId = setTimeout(() => reject(new Error('Stream timeout: Ollama is hung')), timeoutMs);
                    reader.read().then((result) => {
                        clearTimeout(timeoutId);
                        resolve(result);
                    }).catch(err => {
                        clearTimeout(timeoutId);
                        reject(err);
                    });
                });
            };

            while (true) {
                const { done, value } = await readWithTimeout(reader, 120000);
                if (done) break;
                const lines = decoder.decode(value).split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const json = JSON.parse(line);
                    if (json.message?.content) {
                        fullContent += json.message.content;
                        botDiv.innerHTML = window.markedParse(fullContent);
                    }
                    if (json.message?.tool_calls?.length > 0) {
                        toolCalls = json.message.tool_calls;
                    }
                }
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }

            if (agentEnabled && toolCalls?.length > 0) {
                chatHistory.push({ role: 'assistant', content: fullContent, tool_calls: toolCalls });

                const needsVRAMSwap = toolCalls.some(t => t.function.name === 'mem_store' || t.function.name === 'memory_search');
                if (needsVRAMSwap) {
                    await pageOutModel(model); // PAGING: Chat model suspends. Surrender VRAM so memory tools can operate safely.
                }

                for (const t of toolCalls) {
                    const logDiv = document.createElement('div');
                    logDiv.className = 'agent-log';
                    logDiv.textContent = `⚡ Exec: ${t.function.name}\nArgs: ${JSON.stringify(t.function.arguments, null, 2)}`;
                    messagesContainer.insertBefore(logDiv, botDiv);

                    let result;
                    try {
                        result = await executeTool(t.function.name, t.function.arguments);
                    } catch (e) {
                        result = `Error: ${e.message}`;
                    }
                    chatHistory.push({ role: 'tool', content: String(result) });
                }

                botDiv.innerHTML = '<span class="loading-pulse">Processing...</span>';
            } else {
                chatHistory.push({ role: 'assistant', content: fullContent });
                window.api.invoke('save-history', chatHistory);
                if (ttsToggle?.checked && fullContent) {
                    window.api.send('tts-speak', stripMarkdown(fullContent));
                }
                finished = true;
            }
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            botDiv.innerHTML = `<span style="color:#ff4444">Error: Request aborted by user.</span>`;
        } else if (e.message.includes('timeout')) {
            botDiv.innerHTML = `<span style="color:#ff4444">Error: Model timed out. VRAM may be heavily congested. Try clearing memory or restarting Ollama.</span>`;
        } else {
            botDiv.innerHTML = `<span style="color:#ff4444">Error: ${e.message}</span>`;
        }
    } finally {
        sendBtn.style.display = 'block';
        stopBtn.style.display = 'none';
        abortController = null;
    }
}

sendBtn.addEventListener('click', sendMessage);
userInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
init();
