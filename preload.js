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
    'whatsapp-init', 'whatsapp-send', 'open-file-dialog', 'select-directory',
    'load-history', 'save-history', 'clear-history',
    'agent-run-command', 'agent-read-file', 'agent-write-file',
    'agent-delete-file', 'agent-list-directory', 'agent-list-project',
    'agent-read-process-log', 'agent-send-input',
    'agent-stop-process', 'agent-list-processes', 'agent-fetch-url',
    'agent-grep', 'agent-glob', 'agent-get-repo-map', 'agent-verify', 'agent-doctor',
    'edit-apply', 'edit-apply-patch', 'edit-apply-batch',
    'project-get-root', 'project-set-root', 'project-resolve-path',
    'plan-create', 'plan-load', 'plan-save', 'plan-list-active', 'plan-approve', 'plan-detect', 'plan-add-steps',
    'ledger-diff', 'ledger-revert-all',
    'git-init', 'git-status', 'git-diff', 'git-commit', 'git-undo', 'git-log',
    'perform-search',
    'mem-store', 'mem-query', 'mem-count', 'mem-clear',
    'export-session', 'import-session', 'get-host-url', 'get-env-info', 'open-external-url',
    'get-gpu-telemetry', 'app-reset',
    'auth-login', 'auth-register', 'auth-check', 'auth-logout', 'auth-has-users',
    'auth-get-users', 'auth-update-user',
    'plugins-list', 'plugins-get-contributions', 'plugin-invoke-tool',
    'plugin-run-command', 'plugin-fire-hook', 'plugin-set-enabled',
    'plugin-uninstall', 'plugin-install'
];

const SEND_CHANNELS = ['tts-speak', 'tts-stop'];

const RECEIVE_CHANNELS = [
    'whatsapp-qr', 'whatsapp-ready', 'whatsapp-error', 'whatsapp-disconnected',
    'tts-error', 'tts-finished', 'resource-update', 'plugin-ui-event'
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
