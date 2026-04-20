const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

class MemoryManager {
    constructor() {
        try {
            if (app && app.getPath) {
                this.userDataPath = app.getPath('userData');
            } else {
                this.userDataPath = path.join(os.homedir(), '.config', 'xkaliber-agent');
            }
        } catch (e) {
            this.userDataPath = path.join(os.homedir(), '.config', 'xkaliber-agent');
        }
        
        if (!fs.existsSync(this.userDataPath)) {
            fs.mkdirSync(this.userDataPath, { recursive: true });
        }
        
        this.vectorDBPath = path.join(this.userDataPath, 'xkaliber_vectors_v22.json');
        this.vectors = this.loadJSON(this.vectorDBPath, []);
        
        this.ollamaUrl = 'http://127.0.0.1:11434/api';
    }

    loadJSON(filePath, defaultValue) {
        try {
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            }
        } catch (e) {
            console.error(`Failed to load ${filePath}`, e);
        }
        return defaultValue;
    }

    saveJSON(filePath, data) {
        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
            return true;
        } catch (e) {
            console.error(`Failed to save ${filePath}`, e);
            return false;
        }
    }

    async getEmbedding(text, model = 'all-minilm') {
        const performEmbed = async (retryOnFailure = true) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 45000); // 45s timeout

                // REAL-TIME PAGING: 
                // 1. Removed num_gpu: 0 so it can utilize the GPU since the orchestrator cleared VRAM.
                // 2. keep_alive: 0 forces it to immediately page out of VRAM when finished.
                const response = await fetch(`${this.ollamaUrl}/embed`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        model, 
                        input: text,
                        options: { num_gpu: 0 },
                        keep_alive: 0 
                    }),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (!response.ok) {
                    if (response.status === 404 && retryOnFailure) {
                        console.log(`Model ${model} not found. Attempting to pull...`);
                        await this.pullModel(model);
                        return await performEmbed(false);
                    }
                    throw new Error(`Embedding failed: ${response.statusText}`);
                }

                const data = await response.json();
                return data.embeddings?.[0];
            } catch (e) {
                if (retryOnFailure) {
                    console.warn("Embedding failed, retrying once...", e.message);
                    await new Promise(r => setTimeout(r, 2000));
                    return await performEmbed(false);
                }
                console.error('Embedding error after retry', e);
                return null;
            }
        };

        return await performEmbed();
    }

    async pullModel(model) {
        try {
            const pullController = new AbortController();
            const pullTimeoutId = setTimeout(() => pullController.abort(), 300000); 
            const pullRes = await fetch(`${this.ollamaUrl}/pull`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: model }),
                signal: pullController.signal
            });

            if (pullRes.ok && pullRes.body) {
                const reader = pullRes.body.getReader();
                while (true) {
                    const { done } = await reader.read();
                    if (done) break;
                }
            }
            clearTimeout(pullTimeoutId);
        } catch (e) {
            console.error("Failed to pull model", e);
        }
    }

    cosineSimilarity(vecA, vecB) {
        let dotProduct = 0.0, normA = 0.0, normB = 0.0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    getCount() {
        return this.vectors.length;
    }

    clearMemory() {
        this.vectors = [];
        this.saveJSON(this.vectorDBPath, this.vectors);
        return true;
    }

    async storeVector(text, metadata = {}) {
        const embedding = await this.getEmbedding(text);
        if (embedding) {
            this.vectors.push({ text, embedding, metadata, timestamp: Date.now() });
            this.saveJSON(this.vectorDBPath, this.vectors);
            return { success: true };
        }
        return { error: "Embedding failed. Ensure Ollama is running and 'all-minilm' is available." };
    }

    async queryVectors(queryText, limit = 5) {
        const queryEmbedding = await this.getEmbedding(queryText);
        if (!queryEmbedding) return { error: "Embedding failed." };

        const results = this.vectors.map(v => ({
            ...v,
            similarity: this.cosineSimilarity(queryEmbedding, v.embedding)
        }));

        results.sort((a, b) => b.similarity - a.similarity);
        return { success: true, data: results.slice(0, limit).map(r => ({ text: r.text, metadata: r.metadata, similarity: r.similarity })) };
    }
}

module.exports = new MemoryManager();