import { buildToolSchemas, executeTool, isWriteTool, WRITE_TOOLS } from './tools.js';
import { recallMemories, storeMemory }   from './memory.js';

const ANTHROPIC_TIMEOUT_MS = 60_000;
const MAX_TOOL_ROUNDS      = 8;
const MAX_RETRIES          = 2;

// ── Prompts ───────────────────────────────────────────────────────────────────

const PLANNER_PROMPT = `You are a routing agent for an enterprise knowledge base. Your job is to decide which tools to call based on the question type.

ROUTING RULES — follow these strictly:

GITHUB (code, technical):
- Architecture, how something works in code
- Setup, installation, configuration
- File structure, where things are defined
- Deployment pipelines, CI/CD
- Bugs, error handling, specific functions

SLACK (team, operational):
- Incidents, outages, postmortems
- Recent decisions or discussions
- What the team has been working on
- On-call, alerts, pages
- Anything with words: incident, outage, alert, discussion, team, recently, decided

BOTH:
- "How did we handle X incident and where is the fix in code"
- Questions explicitly asking for both context types

DO NOT use GitHub for incident/outage/team questions even if Slack is not connected.
DO NOT use Slack for pure code/architecture questions.
If the right tool is not connected, set steps to [] and explain in reasoning.

Output ONLY a JSON object — no markdown, no backticks:
{
  "reasoning": "one sentence: why these tools for this question",
  "questionType": "github" | "slack" | "both" | "unclear",
  "steps": [
    { "tool": "search_github_repo", "reason": "why", "input": { "owner": "...", "repo": "..." } },
    { "tool": "read_slack_channel", "reason": "why", "input": { "channel_id": "...", "channel_name": "#..." } }
  ],
  "missingSource": null | "github" | "slack"
}`;

const REFLECTION_PROMPT = `You are a quality evaluator for an AI knowledge base agent.

Given a question and a draft answer, score the answer on three criteria (0-10 each):
- completeness: does it fully answer what was asked?
- source_quality: is it grounded in real retrieved data, not guesses?
- confidence: how confident are you this is accurate?

Also provide:
- verdict: "pass" if all scores >= 7, otherwise "retry"
- retry_reason: if verdict is retry, one sentence explaining what is missing
- retry_hint: if verdict is retry, what additional tool call would fix it

Output ONLY a JSON object — no markdown, no backticks:
{
  "completeness": 8,
  "source_quality": 9,
  "confidence": 7,
  "verdict": "pass",
  "retry_reason": null,
  "retry_hint": null
}`;

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(connectedSources, memories) {
  const repoHint = connectedSources.github?.length
    ? `The user's repo is: ${connectedSources.github[0].fullName}. Use this for all technical questions.`
    : `No repo connected yet. Tell the user to fetch a repo in the sidebar.`;

  const slackHint = connectedSources.slack?.length
    ? `Available Slack channels: ${connectedSources.slack.map(c => `${c.name} (id: ${c.id})`).join(', ')}.`
    : `No Slack channels connected yet.`;

  const memoryHint = memories
    ? `\nRELEVANT PAST Q&A (supplemental context — still call tools for fresh data):\n${memories}`
    : '';

  return `You are an enterprise knowledge base agent executing a pre-approved plan.

${repoHint}
${slackHint}${memoryHint}

STRICT RULES:
- You have already been given gathered data — synthesize it into a clear answer
- NEVER guess or answer from prior knowledge — only use what was provided
- NEVER output XML tags like <invoke> or <tool_use> — use the proper API tool_use mechanism only
- If the task requires writing (creating an issue, posting to Slack) — call the write tool directly, do not describe it in text
- End with: SOURCES_USED: [comma-separated list of what you read]`;
}

// ── Claude API call ───────────────────────────────────────────────────────────

async function claudeRequest({ messages, tools, system, maxTokens = 2048, signal }) {
  const body = { model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, messages };
  if (system)      body.system = system;
  if (tools?.length) body.tools = tools;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });

  const data = await res.json();
  if (!res.ok) {
    switch (res.status) {
      case 401: throw new Error('Anthropic API key is invalid — update ANTHROPIC_API_KEY in .env');
      case 429: throw new Error('Anthropic rate limit hit — wait a moment and retry');
      case 500:
      case 529: throw new Error('Anthropic servers are down — try again shortly');
      default:  throw new Error(data.error?.message || `Anthropic error ${res.status}`);
    }
  }
  return data;
}

// ── Phase 1: Plan ─────────────────────────────────────────────────────────────

async function planSteps(question, connectedSources, signal) {
  const hasGitHub = !!connectedSources.github?.length;
  const hasSlack  = !!connectedSources.slack?.length;

  const repoCtx  = hasGitHub
    ? `GitHub connected: ${connectedSources.github[0].fullName}`
    : 'GitHub: NOT connected';
  const slackCtx = hasSlack
    ? `Slack connected: ${connectedSources.slack.map(c => `${c.name} (id:${c.id})`).join(', ')}`
    : 'Slack: NOT connected';

  const response = await claudeRequest({
    system:    PLANNER_PROMPT,
    maxTokens: 512,
    messages:  [{ role: 'user', content: `Question: ${question}\n\n${repoCtx}\n${slackCtx}` }],
    signal,
  });

  const raw = response.content?.find(b => b.type === 'text')?.text || '';
  try {
    const plan = JSON.parse(raw);
    console.log(`[planner] Type: ${plan.questionType} | Reasoning: ${plan.reasoning}`);

    // Detect misrouting: slack question but slack not connected
    if (plan.missingSource === 'slack' || (plan.questionType === 'slack' && !hasSlack)) {
      console.log('[planner] Slack question but Slack not connected — returning guidance');
      return { __missingSlack: true, reasoning: plan.reasoning };
    }

    if (plan.missingSource === 'github' || (plan.questionType === 'github' && !hasGitHub)) {
      console.log('[planner] GitHub question but GitHub not connected — returning guidance');
      return { __missingGithub: true, reasoning: plan.reasoning };
    }

    if (!plan.steps?.length) {
      console.log('[planner] No steps returned — unclear question');
      return { __noSteps: true, reasoning: plan.reasoning };
    }

    console.log(`[planner] Steps: ${plan.steps.map(s => s.tool).join(' → ')}`);
    return plan;
  } catch {
    console.warn('[planner] Could not parse plan, falling back to reactive mode');
    return null;
  }
}

// ── Phase 2: Execute plan steps ───────────────────────────────────────────────

async function executePlan(plan, tokens) {
  const results = [];
  for (const step of plan.steps) {
    console.log(`[planner] Executing: ${step.tool} — ${step.reason}`);
    const result = await executeTool(step.tool, step.input, tokens);
    results.push({ step, result });
  }
  return results;
}

// ── Human-readable action description ────────────────────────────────────────

function describeAction(tool, input) {
  switch (tool) {
    case 'create_github_issue':
      return `Create GitHub issue "${input.title}" in ${input.owner}/${input.repo}`;
    case 'post_slack_message':
      return `Post message to ${input.channel_name}`;
    default:
      return `Execute ${tool}`;
  }
}

// ── Phase 3: Synthesize ───────────────────────────────────────────────────────

async function synthesize({ question, plan, stepResults, connectedSources, memories, tools, signal }) {
  const toolCalls    = [];
  const loopMessages = [];

  // Write-only tools for when plan already fetched read data
  const writeOnlyTools = tools.filter(t => WRITE_TOOLS.includes(t.name));
  // Use write-only if plan ran (read data already provided), otherwise full tools
  const activeTools = plan && stepResults.length ? writeOnlyTools : tools;

  if (plan && stepResults.length) {
    loopMessages.push({
      role:    'user',
      content: `Question: ${question}\n\nI've already gathered the following information:\n\n${
        stepResults.map((r, i) => `Step ${i + 1} (${r.step.tool} — ${r.step.reason}):\n${r.result}`).join('\n\n---\n\n')
      }\n\nSynthesize a complete answer. If the task requires creating a GitHub issue or posting to Slack, use the appropriate tool.`,
    });
  } else {
    loopMessages.push({ role: 'user', content: question });
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await claudeRequest({
      system:    buildSystemPrompt(connectedSources, memories),
      tools:     activeTools,
      messages:  loopMessages,
      maxTokens: 4096,
      signal,
    });

    if (response.stop_reason === 'end_turn') {
      const text = response.content?.find(b => b.type === 'text')?.text;
      if (!text) throw new Error('Anthropic returned an empty response');
      return { text, toolCalls };
    }

    if (response.stop_reason === 'tool_use') {
      const blocks = response.content.filter(b => b.type === 'tool_use');
      loopMessages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const block of blocks) {

        // ── Write tool detected — pause and request approval ──────────────
        if (isWriteTool(block.name)) {
          console.log(`[agent] Write tool detected: ${block.name} — pausing for approval`);
          return {
            text:          null,
            toolCalls,
            pendingAction: {
              id:          block.id,
              tool:        block.name,
              input:       block.input,
              description: describeAction(block.name, block.input),
            },
          };
        }

        // ── Read tool — execute immediately ───────────────────────────────
        console.log(`[agent] Reactive tool call: ${block.name}`, block.input);
        toolCalls.push({ tool: block.name, input: block.input });
        const result = await executeTool(block.name, block.input, {});
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
      loopMessages.push({ role: 'user', content: toolResults });
      continue;
    }

    throw new Error(`Unexpected stop reason: ${response.stop_reason}`);
  }
  throw new Error('Agent exceeded max rounds');
}

// ── Phase 4: Reflect ──────────────────────────────────────────────────────────

async function reflect(question, answer, signal) {
  try {
    const response = await claudeRequest({
      system:    REFLECTION_PROMPT,
      maxTokens: 256,
      messages:  [{ role: 'user', content: `Question: ${question}\n\nDraft answer:\n${answer}` }],
      signal,
    });
    const raw        = response.content?.find(b => b.type === 'text')?.text || '';
    const evaluation = JSON.parse(raw);
    console.log(`[reflect] completeness:${evaluation.completeness} source:${evaluation.source_quality} confidence:${evaluation.confidence} → ${evaluation.verdict}`);
    if (evaluation.verdict === 'retry')
      console.log(`[reflect] Retry reason: ${evaluation.retry_reason}`);
    return evaluation;
  } catch (err) {
    console.warn('[reflect] Could not evaluate:', err.message);
    return { verdict: 'pass' }; // non-critical — pass through on failure
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function askAgent(messages, connectedSources, tokens) {
  if (!process.env.ANTHROPIC_API_KEY)
    throw new Error('ANTHROPIC_API_KEY is not set — add it to your .env file');

  const tools        = buildToolSchemas(connectedSources);
  const lastQuestion = messages.filter(m => m.role === 'user').at(-1)?.content || '';
  const memories     = await recallMemories(lastQuestion);

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);

  try {
    // Phase 1: Plan
    const plan = await planSteps(lastQuestion, connectedSources, controller.signal);

    // Short-circuit if planner detected a missing source
    if (plan?.__missingSlack) {
      return {
        reply: `This looks like a question about team discussions or incidents — that information lives in Slack.\n\nTo answer this properly, connect Slack using the sidebar and enable the relevant channels (e.g. #incidents, #engineering).\n\nSOURCES_USED: none`,
        toolCalls: [], plan: null, memoriesUsed: false,
        reflection: { completeness: null, source_quality: null, confidence: null, retried: false, retryCount: 0 },
      };
    }
    if (plan?.__missingGithub) {
      return {
        reply: `This looks like a technical/code question — that information lives in your GitHub repo.\n\nTo answer this properly, connect GitHub using the sidebar and select a repo.\n\nSOURCES_USED: none`,
        toolCalls: [], plan: null, memoriesUsed: false,
        reflection: { completeness: null, source_quality: null, confidence: null, retried: false, retryCount: 0 },
      };
    }
    if (plan?.__noSteps) {
      return {
        reply: `I wasn't sure which source to search for that question. Could you be more specific?\n\nExamples:\n- "How does authentication work?" → searches your repo\n- "What happened in the last incident?" → searches Slack\n\nSOURCES_USED: none`,
        toolCalls: [], plan: null, memoriesUsed: false,
        reflection: { completeness: null, source_quality: null, confidence: null, retried: false, retryCount: 0 },
      };
    }

    // Phase 2: Execute
    const stepResults  = plan ? await executePlan(plan, tokens) : [];
    const allToolCalls = stepResults.map(r => ({
      tool: r.step.tool, input: r.step.input, reason: r.step.reason, status: 'done',
    }));

    // Phase 3 + 4: Synthesize → Reflect → Retry loop
    let currentPlan  = plan;
    let currentSteps = stepResults;
    let finalText    = null;
    let reflections  = [];
    let retryCount   = 0;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const { text, toolCalls: reactiveCalls, pendingAction } = await synthesize({
        question:        lastQuestion,
        plan:            currentPlan,
        stepResults:     currentSteps,
        connectedSources,
        memories,
        tools,
        signal:          controller.signal,
      });
      reactiveCalls.forEach(c => allToolCalls.push({ ...c, status: 'done' }));

      // ── Write tool needs approval — return immediately ─────────────────
      if (pendingAction) {
        return {
          reply:         null,
          toolCalls:     allToolCalls,
          plan:          plan ? { reasoning: plan.reasoning, steps: plan.steps.map(s => ({ tool: s.tool, reason: s.reason })) } : null,
          memoriesUsed:  !!memories,
          pendingAction,
          reflection:    { completeness: null, source_quality: null, confidence: null, retried: false, retryCount: 0 },
        };
      }

      const evaluation = await reflect(lastQuestion, text, controller.signal);
      reflections.push(evaluation);

      if (evaluation.verdict === 'pass' || attempt === MAX_RETRIES) {
        finalText = text;
        break;
      }

      // Retry with reflection hint
      retryCount++;
      console.log(`[reflect] Retrying (attempt ${retryCount})...`);
      const retryPlan = await planSteps(
        `${lastQuestion}\n\nAdditional context needed: ${evaluation.retry_hint}`,
        connectedSources,
        controller.signal,
      );
      if (retryPlan) {
        const retrySteps = await executePlan(retryPlan, tokens);
        retrySteps.forEach(r => allToolCalls.push({ tool: r.step.tool, input: r.step.input, reason: r.step.reason, status: 'done' }));
        currentPlan  = retryPlan;
        currentSteps = [...currentSteps, ...retrySteps];
      } else {
        finalText = text;
        break;
      }
    }

    // Store in memory
    const srcMatch = finalText.match(/SOURCES_USED:\s*(.+)/i);
    const sources  = srcMatch ? srcMatch[1].split(',').map(s => s.trim()) : [];
    storeMemory({ question: lastQuestion, answer: finalText, sources }).catch(() => {});

    const lastEval = reflections.at(-1) || {};
    return {
      reply:        finalText,
      toolCalls:    allToolCalls,
      plan:         plan ? { reasoning: plan.reasoning, steps: plan.steps.map(s => ({ tool: s.tool, reason: s.reason })) } : null,
      memoriesUsed: !!memories,
      reflection: {
        completeness:   lastEval.completeness   || null,
        source_quality: lastEval.source_quality || null,
        confidence:     lastEval.confidence     || null,
        retried:        retryCount > 0,
        retryCount,
      },
    };

  } catch (err) {
    if (err.name === 'AbortError')
      throw new Error(`Request timed out after ${ANTHROPIC_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}