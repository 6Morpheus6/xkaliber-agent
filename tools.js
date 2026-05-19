const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const memoryManager = require('./memory');

const activeProcesses = new Map();
let nextJobId = 1;

const AGENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'task_begin',
            description: 'State your goal and a multi-step plan before starting a complex task. This helps maintain focus and context.',
            parameters: { type: 'object', properties: { goal: { type: 'string' }, plan: { type: 'array', items: { type: 'string' } } }, required: ['goal', 'plan'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'task_complete',
            description: 'Signal that the task is finished. Provide a final summary of what was accomplished and any verification results.',
            parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'run_shell_command',
            description: 'Execute a bash shell command. USE THIS to check system state, running processes, network, or execute scripts. Sudo is not supported interactively. For long-running tasks, set is_background to true.',
            parameters: { type: 'object', properties: { command: { type: 'string' }, is_background: { type: 'boolean' } }, required: ['command'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_process_log',
            description: 'Read the output log of a background process.',
            parameters: { type: 'object', properties: { job_id: { type: 'string' }, lines: { type: 'number' } }, required: ['job_id'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'send_input',
            description: 'Send input to an active background process.',
            parameters: { type: 'object', properties: { job_id: { type: 'string' }, input: { type: 'string' } }, required: ['job_id', 'input'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a file from the host system.',
            parameters: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Create or overwrite a file on the host system.',
            parameters: { type: 'object', properties: { filepath: { type: 'string' }, content: { type: 'string' } }, required: ['filepath', 'content'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_file',
            description: 'Delete a file or directory on the host system.',
            parameters: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List contents of a directory.',
            parameters: { type: 'object', properties: { dirpath: { type: 'string' } }, required: ['dirpath'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'save_new_user_fact_only',
            description: 'Store a permanent fact about the user. EXTREMELY SELECTIVE.',
            parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the web for information.',
            parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'memory_search',
            description: 'Search long-term memory.',
            parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'memory_purge',
            description: 'Request system resource optimization.',
            parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] }
        }
    }
];

async function performWebSearch(query) {
    try {
        const searchUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
        const response = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        if (!response.ok) return 'Search failed.';
        const html = await response.text();
        const results = [];
        const bodies = html.split('result__body');
        for (let i = 1; i < Math.min(bodies.length, 7); i++) {
            const block = bodies[i];
            const titleMatch = block.match(/result__a[^>]*>(.*?)<\/a>/);
            const snippetMatch = block.match(/result__snippet[^>]*>(.*?)<\/a>/);
            const urlMatch = block.match(/href="([^"]+)"/);
            if (titleMatch && urlMatch) {
                results.push({
                    title: titleMatch[1].replace(/<[^>]*>/g, ''),
                    snippet: (snippetMatch ? snippetMatch[1] : '').replace(/<[^>]*>/g, ''),
                    url: urlMatch[1]
                });
            }
        }
        return results.length > 0 ? 'Web search findings: ' + results.map(r => r.title + ': ' + r.snippet + ' (' + r.url + ')').join('; ') : 'No relevant results found.';
    } catch (e) {
        return 'Search error: ' + e.message;
    }
}

const MAX_OUTPUT_LENGTH = 15000;
function truncate(text) {
    if (text.length <= MAX_OUTPUT_LENGTH) return text;
    return text.substring(0, MAX_OUTPUT_LENGTH) + '

[Output truncated...]';
}

async function executeTool(name, args) {
    if (name === 'task_begin') return 'Task started. Please proceed with your plan.';
    if (name === 'task_complete') return 'Task completed. Finalizing response.';
    
    if (name === 'web_search') return await performWebSearch(args.query);
    
    if (name === 'run_shell_command') {
        if (args.is_background) {
            const jobId = nextJobId++;
            const child = spawn('bash', ['-c', args.command], { cwd: process.env.HOME || process.cwd() });
            const procInfo = { process: child, log: [] };
            activeProcesses.set(jobId, procInfo);
            child.stdout.on('data', d => procInfo.log.push(d.toString()));
            child.stderr.on('data', d => procInfo.log.push(d.toString()));
            child.on('close', c => procInfo.log.push('[Exited: ' + c + ']'));
            return 'Background job started ID: ' + jobId;
        }
        try {
            const out = execSync(args.command, { encoding: 'utf-8', stdio: 'pipe' });
            return truncate(out || 'Success');
        } catch (e) {
            return truncate('Error: ' + e.message + '
' + e.stderr);
        }
    }
    
    if (name === 'read_file') {
        try { return truncate(fs.readFileSync(path.resolve(args.filepath), 'utf-8')); }
        catch (e) { return 'Read error: ' + e.message; }
    }
    
    if (name === 'write_file') {
        try { 
            fs.writeFileSync(path.resolve(args.filepath), args.content, 'utf-8');
            return 'File written successfully.';
        } catch (e) { return 'Write error: ' + e.message; }
    }
    
    if (name === 'list_directory') {
        try { return truncate(fs.readdirSync(path.resolve(args.dirpath || '.')).join('
')); }
        catch (e) { return 'List error: ' + e.message; }
    }

    if (name === 'save_new_user_fact_only') {
        const res = await memoryManager.storeVector(args.text);
        return res.success ? 'Memory stored.' : 'Error: ' + res.error;
    }
    
    if (name === 'memory_search') {
        const mems = await memoryManager.queryVectors(args.query);
        return mems.length > 0 ? mems.map(m => m.text).join('
') : 'No memory found';
    }

    return 'Tool ' + name + ' executed.';
}

module.exports = { AGENT_TOOLS, executeTool };