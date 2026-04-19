⚔️kaliber Agent v21
The Definitive Autonomous Desktop Client for Local Intelligence.

Xkaliber Agent is a modern, dark-themed Electron interface that transforms local Ollama models into fully capable system operators. Beyond simple chat, v21 equips your neural models with persistent vector memory, secure system-level execution, real-time web scraping, and multimodal integration.

🧠 Neuro-Core: Intelligent Persistent Memory
Powered by a "Clawbot-style" long-term memory engine, the agent doesn't just chat—it learns and evolves.

Dynamic VRAM Management: The agent autonomously monitors GPU resources. If VRAM is congested during a memory operation, it will suspend idle models to ensure Neuro-Core remains operational.

Autonomous Learning: Using the mem_store tool, the agent intelligently decides which facts, user preferences, or project details are worth vectorizing for the long term.

Offline Embeddings: Utilizes the all-minilm engine. If missing, Xkaliber Agent securely streams and auto-installs it on the first boot.

Secure Vector Storage: Databases are written directly to ~/.config/xkaliber-agent/ via IPC, bypassing browser sandbox limitations for true persistence.

Real-time Feedback: Monitor your agent's brain with the [X MEMS] counter and the [ NEURO-CORE SAVING... ] status indicator.

🛡️ System Access & Secure Sudo
Xkaliber Agent acts as a bridge between the LLM and your hardware.

Host Execution: Run bash commands directly on your machine to manage files, install packages, or configure services.

Sudo Injection: Provide your password in the secure UI field; the agent dynamically pipes it (echo | sudo -S) for root tasks without ever saving your password to logs or neural memory.

🛠️ The Agentic Toolbelt
View every action in real-time with transparent execution logs (⚡ Exec: function_name).

File Ops: read, write, list, and delete files across the system.

Memory: High-speed vector_search and mem_store.

Netrunner: Real-time web search via a secure DuckDuckGo scraper (No API keys required).

Communication: Autonomous WhatsApp messaging via QR-linked sessions.

Logic: dynamic_schema_generate for creating perfectly structured JSON data.

🔊 Audio & Multimodal Uplink
Piper TTS: Crystal-clear, 100% offline Text-to-Speech (en_US-lessac-medium).

Vision & Context: Drag-and-drop images for vision-model analysis or text files for instant context injection.
everything in releases section !!!!!

(THIS ONLY SUPPORTS OLLAMA)

(you dont need api for web access and surfing)

(works out the box just download ur favorite llm from ollama)

openclaw alternative

🚀 Core Features
⚡ 1. Autonomous Agent Mode (System Harness)
Toggle the Sys-Access harness to give your AI "True Agency." The model operates in a continuous loop, autonomously selecting tools to fulfill complex requests:

Shell Autonomy: Execute bash commands and scripts directly.

File Operations: Read, write, delete, and navigate local directory structures.

API Interaction: Make raw HTTP requests to interact with external REST APIs or local services.

Netrunner Mode: Perform live web searches to inject real-time data into the neural stream.

Sensor Fusion: The agent can poll ultrasonic, IR, and touch sensors to make environment-aware decisions.

📱 3. Remote Web Interface (Mobile Optimized)
Turn your host into a localized AI server with the Enable Localhost toggle:


Smart Networking: Automatically detects your local IP and manages port conflicts (defaulting to 18789).

Perfect Mobile UX: Optimized with dynamic viewports (100dvh), anti-zoom scaling, and touch-friendly UI components.

👁️ 4. Multimodal & Vision
Vision Analysis: Use models like Llava or Bakllava to analyze, describe, and extract data from images.


be sure to check out the cli version. after install type xagent to spawn in terminal

🗣️ 5. Offline Comms
Piper TTS: High-speed, high-quality voice synthesis that runs 100% offline.

WhatsApp Bridge: Authenticate via QR code to allow the AI to send notifications and alerts directly to your phone.


(ssh fucntion in testing but all other functions work)


<img width="1920" height="1200" alt="agent" src="https://github.com/user-attachments/assets/f6705305-7a1a-4ceb-bd4f-3f657a860400" />
