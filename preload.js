const { contextBridge, ipcRenderer } = require('electron');
const markedModule = require('marked');

try {
    const hljs = require('highlight.js');
    markedModule.use({
        renderer: {
            code(tokenOrText, langArg) {
                const text = typeof tokenOrText === 'object' ? tokenOrText.text : tokenOrText;
                const lang = typeof tokenOrText === 'object' ? tokenOrText.lang : langArg;
                try {
                    if (lang && hljs.getLanguage(lang)) {
                        return `<pre><code class="hljs language-${lang}">${hljs.highlight(text, { language: lang }).value}</code></pre>`;
                    }
                    return `<pre><code class="hljs">${hljs.highlightAuto(text).value}</code></pre>`;
                } catch (e) {
                    return `<pre><code>${text}</code></pre>`;
                }
            }
        }
    });
} catch (e) {
    // highlight.js not installed — code blocks render without highlighting
}

const INVOKE_CHANNELS = [
    'whatsapp-init', 'whatsapp-send', 'open-file-dialog',
    'load-history', 'save-history', 'clear-history',
    'agent-run-command', 'agent-read-file', 'agent-write-file',
    'agent-delete-file', 'agent-list-directory',
    'perform-search',
    'mem-store', 'mem-query', 'mem-count', 'mem-clear',
    'export-session', 'import-session'
];

const SEND_CHANNELS = ['tts-speak', 'tts-stop'];

const RECEIVE_CHANNELS = [
    'whatsapp-qr', 'whatsapp-ready', 'whatsapp-error', 'whatsapp-disconnected',
    'tts-error', 'tts-finished'
];

contextBridge.exposeInMainWorld('api', {
    invoke: (channel, ...args) => {
        if (!INVOKE_CHANNELS.includes(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
        return ipcRenderer.invoke(channel, ...args);
    },
    send: (channel, ...args) => {
        if (!SEND_CHANNELS.includes(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
        ipcRenderer.send(channel, ...args);
    },
    on: (channel, callback) => {
        if (!RECEIVE_CHANNELS.includes(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
        const handler = (_event, ...args) => callback(...args);
        ipcRenderer.on(channel, handler);
        return () => ipcRenderer.removeListener(channel, handler);
    }
});

contextBridge.exposeInMainWorld('markedParse', (text) => markedModule.parse(text));
