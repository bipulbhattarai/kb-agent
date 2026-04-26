import fs   from 'fs/promises';
import path  from 'path';
import { fileURLToPath } from 'url';

const __dir       = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.join(__dir, '../memory.json');
const TOP_K       = 3;
const MIN_SCORE   = 0.75;

// ── Embedding providers ───────────────────────────────────────────────────────
// Auto-selects OpenAI if OPENAI_API_KEY is set, otherwise uses local model

let _localPipeline = null;

async function embedWithOpenAI(text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI embeddings error: ${data.error?.message}`);
  return data.data[0].embedding;
}

async function embedWithLocal(text) {
  if (!_localPipeline) {
    console.log('[memory] Loading local embedding model (first run ~25MB download)...');
    const { pipeline } = await import('@xenova/transformers');
    _localPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('[memory] Local embedding model ready');
  }
  const output = await _localPipeline(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

async function embed(text) {
  if (process.env.OPENAI_API_KEY) {
    try {
      return await embedWithOpenAI(text);
    } catch (err) {
      // If OpenAI fails (quota, network), fall back to local
      console.warn(`[memory] OpenAI embedding failed (${err.message}) — falling back to local model`);
      return await embedWithLocal(text);
    }
  }
  return await embedWithLocal(text);
}

export function getEmbeddingProvider() {
  return process.env.OPENAI_API_KEY ? 'openai' : 'local';
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

function cosine(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── File I/O ──────────────────────────────────────────────────────────────────

async function loadMemories() {
  try { return JSON.parse(await fs.readFile(MEMORY_FILE, 'utf-8')); }
  catch { return []; }
}

async function saveMemories(memories) {
  await fs.writeFile(MEMORY_FILE, JSON.stringify(memories, null, 2));
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function storeMemory({ question, answer, sources = [] }) {
  try {
    const embedding = await embed(question);
    const memories  = await loadMemories();
    memories.push({
      id: Date.now(), question, answer, sources,
      embedding, provider: getEmbeddingProvider(),
      createdAt: new Date().toISOString(),
    });
    await saveMemories(memories);
    console.log(`[memory] Stored via ${getEmbeddingProvider()}. Total: ${memories.length}`);
  } catch (err) {
    console.warn('[memory] Could not store:', err.message);
  }
}

export async function recallMemories(question) {
  try {
    const memories = await loadMemories();
    if (!memories.length) return null;
    const queryEmbedding = await embed(question);
    const scored = memories
      .map(m => ({ ...m, score: cosine(queryEmbedding, m.embedding) }))
      .filter(m => m.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K);
    if (!scored.length) return null;
    console.log(`[memory] Recalled ${scored.length} memories (top score: ${scored[0].score.toFixed(3)})`);
    return scored.map((m, i) =>
      `[Memory ${i + 1}] Q: ${m.question}\nA: ${m.answer}${m.sources.length ? `\nSources: ${m.sources.join(', ')}` : ''}`
    ).join('\n\n');
  } catch (err) {
    console.warn('[memory] Could not recall:', err.message);
    return null;
  }
}

export async function listMemories() {
  const memories = await loadMemories();
  return memories.map(({ embedding: _e, ...rest }) => rest);
}

export async function deleteMemory(id) {
  const memories = await loadMemories();
  const filtered = memories.filter(m => m.id !== id);
  await saveMemories(filtered);
  return filtered.length < memories.length;
}