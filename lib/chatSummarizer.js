const CHARS_PER_TOKEN = 3.5;

function estimateTokens(text) {
    return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

function estimateMessagesTokens(messages) {
    return messages.reduce((sum, m) => sum + estimateTokens(JSON.stringify(m)), 0);
}

/**
 * Trim messages from the front until under budget; returns { kept, droppedCount }.
 * Does not drop system messages (index 0).
 */
function trimMessagesToBudget(messages, maxTokens) {
    if (!messages.length) return { kept: [], droppedCount: 0 };
    const system = messages[0]?.role === 'system' ? [messages[0]] : [];
    const rest = messages[0]?.role === 'system' ? messages.slice(1) : [...messages];
    let dropped = 0;
    while (rest.length > 2 && estimateMessagesTokens([...system, ...rest]) > maxTokens) {
        rest.shift();
        dropped++;
    }
    return { kept: [...system, ...rest], droppedCount: dropped };
}

function buildSummarizePrompt(droppedMessages) {
    const transcript = droppedMessages.map(m => {
        if (m.role === 'user') return `USER: ${m.content}`;
        if (m.role === 'assistant') return `ASSISTANT: ${m.content}`;
        if (m.role === 'tool') return `TOOL(${m.name}): ${String(m.content).slice(0, 500)}`;
        return '';
    }).filter(Boolean).join('\n');
    return `Summarize this conversation segment for a coding agent scratchpad. Keep: decisions, files touched, errors, current state. Max 800 words.\n\n${transcript}`;
}

module.exports = {
    estimateTokens,
    estimateMessagesTokens,
    trimMessagesToBudget,
    buildSummarizePrompt,
    CHARS_PER_TOKEN
};
