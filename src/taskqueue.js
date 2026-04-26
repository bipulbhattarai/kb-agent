import { buildToolSchemas, executeTool } from './tools.js';
import { recallMemories, storeMemory } from './memory.js';

// ── Task decomposer ───────────────────────────────────────────────────────────

const DECOMPOSER_PROMPT = `You are a task decomposition agent for an enterprise knowledge base.

Given a complex request, break it into 2-6 concrete, executable sub-tasks.
Each sub-task should be answerable independently using GitHub or Slack.

Output ONLY a JSON array — no markdown, no backticks:
[
  {
    "id": 1,
    "title": "Short task title",
    "question": "The specific question to answer for this sub-task",
    "type": "github" | "slack" | "both"
  }
]

Rules:
- Each task must be specific and actionable
- Tasks should build on each other when possible
- Max 6 tasks — be focused
- For write actions (create issue, post message) include as the final task`;

export async function decomposeTask(request, connectedSources) {
  const repoCtx  = connectedSources.github?.length
    ? `GitHub repo: ${connectedSources.github[0].fullName}`
    : 'No GitHub connected';
  const slackCtx = connectedSources.slack?.length
    ? `Slack channels: ${connectedSources.slack.map(c => c.name).join(', ')}`
    : 'No Slack connected';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: DECOMPOSER_PROMPT,
      messages: [{ role: 'user', content: `Request: ${request}\n\n${repoCtx}\n${slackCtx}` }],
    }),
  });

  const data = await res.json();
  const raw  = data.content?.[0]?.text || '[]';
  try {
    return JSON.parse(raw);
  } catch {
    // Fallback: treat as single task
    return [{ id: 1, title: 'Process request', question: request, type: 'both' }];
  }
}

// ── Task runner — streams progress via SSE ────────────────────────────────────

export async function runTaskQueue(request, connectedSources, tokens, sseRes) {
  const send = (event, data) => {
    sseRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Step 1: Decompose
    send('status', { message: '🗂 Breaking down your request...' });
    const tasks = await decomposeTask(request, connectedSources);
    send('tasks', { tasks: tasks.map(t => ({ ...t, status: 'pending' })) });

    const tools    = buildToolSchemas(connectedSources);
    const results  = [];

    // Step 2: Execute each task
    for (const task of tasks) {
      send('task_start', { id: task.id, title: task.title });

      try {
        const memories = await recallMemories(task.question).catch(() => null);

        // Simple single-task agent call
        const agentRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2048,
            system: buildTaskSystemPrompt(connectedSources, results, memories),
            tools,
            messages: [{ role: 'user', content: task.question }],
          }),
        });

        const agentData = await agentRes.json();
        let   answer    = '';
        let   toolsUsed = [];

        // Handle tool calls
        if (agentData.stop_reason === 'tool_use') {
          const loopMsgs = [{ role: 'user', content: task.question }];
          loopMsgs.push({ role: 'assistant', content: agentData.content });

          const toolResults = [];
          for (const block of agentData.content.filter(b => b.type === 'tool_use')) {
            send('tool_call', { taskId: task.id, tool: block.name, input: block.input });
            toolsUsed.push(block.name);

            const result = await executeTool(block.name, block.input, tokens);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
          }

          loopMsgs.push({ role: 'user', content: toolResults });

          const finalRes  = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 2048,
              system: buildTaskSystemPrompt(connectedSources, results, memories),
              messages: loopMsgs,
            }),
          });

          const finalData = await finalRes.json();
          answer = finalData.content?.find(b => b.type === 'text')?.text || '';
        } else {
          answer = agentData.content?.find(b => b.type === 'text')?.text || '';
        }

        results.push({ taskId: task.id, title: task.title, answer, toolsUsed });
        storeMemory({ question: task.question, answer, sources: toolsUsed }).catch(() => {});

        send('task_done', { id: task.id, answer, toolsUsed });

      } catch (err) {
        send('task_error', { id: task.id, error: err.message });
        results.push({ taskId: task.id, title: task.title, answer: `Error: ${err.message}`, toolsUsed: [] });
      }
    }

    // Step 3: Final summary
    send('status', { message: '✍️ Generating summary...' });
    const summaryRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Summarize these task results into a concise final answer:\n\n${
            results.map(r => `## ${r.title}\n${r.answer}`).join('\n\n')
          }`,
        }],
      }),
    });

    const summaryData = await summaryRes.json();
    const summary = summaryData.content?.[0]?.text || 'All tasks completed.';

    send('complete', { summary, totalTasks: tasks.length });

  } catch (err) {
    send('error', { message: err.message });
  } finally {
    sseRes.end();
  }
}

function buildTaskSystemPrompt(connectedSources, previousResults, memories) {
  const repoHint = connectedSources.github?.length
    ? `GitHub repo: ${connectedSources.github[0].fullName}`
    : 'No GitHub connected';
  const memHint = memories
    ? `\nRELEVANT MEMORY:\n${memories}` : '';
  const prevHint = previousResults.length
    ? `\nPREVIOUS TASK RESULTS (use as context):\n${previousResults.map(r => `${r.title}: ${r.answer.slice(0, 300)}`).join('\n\n')}`
    : '';

  return `You are an enterprise knowledge base agent working through a task queue.
${repoHint}${memHint}${prevHint}

Use tools to find information. Be concise — this is one step in a larger task.
NEVER guess — only use what tools return.`;
}