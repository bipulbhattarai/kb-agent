# KB Agent — Enterprise Agentic Knowledge Base

> An autonomous AI agent that connects to your GitHub repos and Slack workspace, answers questions from real source data, plans multi-step tasks, reflects on answer quality, and requires human approval before writing anything.

Built with **Claude claude-sonnet-4-20250514**, **Node.js**, and **Express** — showcasing production-grade agentic AI patterns for enterprise use.

---

## Agentic Features

### 🗂 Multi-Tool Planning
Before executing, the agent generates a step-by-step JSON plan — deciding which sources (GitHub or Slack) to query and in what order. Questions are intelligently routed: code questions go to GitHub, incident/team questions go to Slack.

### 🔁 Reflection & Retry
After synthesizing an answer, a separate evaluator scores it on completeness, source quality, and confidence (each out of 10). If any score is below 7, the agent automatically retries with a refined plan — up to 2 times.

### 🧠 Semantic Memory
Every Q&A pair is embedded and stored locally. On each new question, the top 3 semantically similar past answers are recalled via cosine similarity and injected as context. Supports OpenAI `text-embedding-3-small` with automatic fallback to local `all-MiniLM-L6-v2` via Transformers.js.

### ✅ Human-in-the-Loop
Write actions (`create_github_issue`, `post_slack_message`) are intercepted before execution. The agent presents an approval card showing exactly what it plans to do — with the full payload visible. You approve, edit, or reject. Nothing is written without explicit human sign-off.

### ⚡ Task Queue
Give the agent a complex multi-step job. It decomposes the request into 2–6 concrete sub-tasks, executes each one sequentially with live SSE streaming, and synthesizes a final summary. Progress is streamed in real time — each task card updates as it completes.

### 🔐 OAuth Authentication
GitHub and Slack connect via OAuth 2.0. Tokens are stored server-side in encrypted sessions — never exposed to the browser. The frontend only calls your own `/api/*` endpoints.

---

## Architecture

```
Browser (index.html)
    │
    │  HTTP /api/*  (no tokens in browser)
    ▼
Express Server (server.js)
    ├── auth.js       → GitHub + Slack OAuth 2.0 flows
    ├── agent.js      → 4-phase agentic loop (plan → execute → synthesize → reflect)
    ├── tools.js      → Read tools (GitHub, Slack) + Write tools (issues, messages)
    ├── taskqueue.js  → Task decomposition + SSE streaming
    ├── memory.js     → Semantic embeddings + cosine similarity recall
    ├── github.js     → GitHub REST API connector
    └── slack.js      → Slack API connector
         │
         ├── Anthropic API  (Claude claude-sonnet-4-20250514)
         ├── GitHub API     (repos, files, issues)
         ├── Slack API      (channels, messages, posts)
         └── OpenAI API     (embeddings — optional, falls back to local)
```

### Agentic Loop (per question)

```
Question
  │
  ├─ 1. PLAN       → Claude outputs JSON plan: which tools, in what order
  ├─ 2. EXECUTE    → Tools run sequentially, results collected
  ├─ 3. SYNTHESIZE → Claude writes answer from tool results
  ├─ 4. REFLECT    → Evaluator scores answer (0–10 each dimension)
  │      └─ score < 7 → RETRY with refined plan (max 2x)
  └─ 5. STORE      → Q&A embedded and saved to memory.json
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| AI Model | Anthropic Claude claude-sonnet-4-20250514 |
| Backend | Node.js 20+, Express 4 |
| Auth | OAuth 2.0 (GitHub + Slack), express-session |
| Embeddings | OpenAI text-embedding-3-small / Xenova all-MiniLM-L6-v2 (local fallback) |
| Streaming | Server-Sent Events (SSE) |
| Frontend | Vanilla HTML/CSS/JS (zero build step) |
| Storage | JSON file (memory.json) — drop-in replaceable with pgvector |

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/bipulbhattarai/kb-agent.git
cd kb-agent
npm install
```

### 2. Create OAuth apps

**GitHub OAuth App** → [github.com/settings/developers](https://github.com/settings/developers)
- Homepage URL: `http://localhost:3000`
- Callback URL: `http://localhost:3000/auth/github/callback`

**Slack App** → [api.slack.com/apps](https://api.slack.com/apps)
- Redirect URL: `http://localhost:3000/auth/slack/callback`
- Bot Token Scopes: `channels:read`, `channels:history`, `groups:read`, `groups:history`, `chat:write`

### 3. Configure environment

```bash
cp .env.example .env
```

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_CALLBACK_URL=http://localhost:3000/auth/slack/callback
SESSION_SECRET=<random-string>

# Optional — uses local model if not set
OPENAI_API_KEY=sk-...
```

### 4. Run

```bash
npm run dev
# → http://localhost:3000
```

---

## Usage

### Chat mode
1. Click **Connect GitHub** → authorize → select a repo from the picker
2. Click **Connect Slack** → authorize → toggle channels on
3. Ask anything in plain English

### Task queue
1. Click **⚡ Tasks** in the sidebar
2. Enter a complex multi-step request
3. Watch the agent decompose it and stream progress live

### Write actions
Ask the agent to create a GitHub issue or post to Slack — an approval card appears with the full payload. Click **Approve** to execute or **Reject** to cancel.

---

## Project Structure

```
kb-agent/
├── src/
│   ├── server.js       # Express routes + session management
│   ├── agent.js        # 4-phase agentic loop
│   ├── tools.js        # Tool schemas + read/write executors
│   ├── taskqueue.js    # Task decomposition + SSE streaming
│   ├── memory.js       # Semantic memory with embeddings
│   ├── github.js       # GitHub API connector
│   ├── slack.js        # Slack API connector
│   └── auth.js         # OAuth 2.0 flows
├── public/
│   └── index.html      # Single-file frontend (no build step)
├── .env.example
├── package.json
└── README.md
```

---

## Security Model

- **No tokens in the browser** — all API keys and OAuth tokens live in server-side sessions
- **Minimal OAuth scopes** — GitHub: `repo read:org` · Slack: read + `chat:write` only
- **Human approval gate** — all write operations require explicit user confirmation
- **`.env` never committed** — listed in `.gitignore`

---

## What This Demonstrates

| Agentic Pattern | Implementation |
|---|---|
| Tool use | Claude selects tools dynamically based on question type |
| Multi-step planning | JSON plan generated before any tool is called |
| Reflection & self-correction | Answer quality scored, retried if below threshold |
| Semantic memory | Embeddings + cosine similarity across sessions |
| Human-in-the-loop | Approval gate for all write actions |
| Streaming agents | SSE task queue with live per-task progress |
| Secure OAuth | Server-side token storage, never browser-exposed |

---

## Roadmap

- [ ] Vector database (pgvector / Pinecone) for large-scale memory
- [ ] Proactive Slack monitoring with incident alerts
- [ ] Multi-agent orchestration (specialist sub-agents per domain)
- [ ] SSO / team auth for multi-user deployment
- [ ] Jira and Confluence connectors

---

## License

MIT