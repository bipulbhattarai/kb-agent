import { fetchGitHubSources } from './github.js';
import { fetchChannelMessages } from './slack.js';

// ── Read-only tools (execute immediately) ─────────────────────────────────────
const READ_TOOLS = ['search_github_repo', 'read_slack_channel'];

// ── Write tools (require human approval) ─────────────────────────────────────
export const WRITE_TOOLS = ['create_github_issue', 'post_slack_message'];

export function isWriteTool(name) { return WRITE_TOOLS.includes(name); }

// ── Tool schemas ──────────────────────────────────────────────────────────────

export function buildToolSchemas(connectedSources) {
  const repos    = connectedSources.github || [];
  const channels = connectedSources.slack  || [];

  return [
    // ── Read tools ──────────────────────────────────────────────────────────
    {
      name: 'search_github_repo',
      description: `Search a GitHub repository for docs, architecture, setup guides, and file structure.
Use for: code questions, deployment, configuration, architecture.
${repos.length ? `Available repos: ${repos.map(r => r.fullName).join(', ')}` : 'Ask the user which repo to search.'}`,
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'GitHub owner or org name' },
          repo:  { type: 'string', description: 'Repository name' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'read_slack_channel',
      description: `Read recent messages from a Slack channel.
Use for: incidents, team discussions, recent decisions, deployments.
${channels.length ? `Available channels: ${channels.map(c => c.name).join(', ')}` : 'Ask the user which channel to read.'}`,
      input_schema: {
        type: 'object',
        properties: {
          channel_id:   { type: 'string', description: 'Slack channel ID' },
          channel_name: { type: 'string', description: 'Channel name e.g. #engineering' },
        },
        required: ['channel_id', 'channel_name'],
      },
    },

    // ── Write tools (require approval before execution) ─────────────────────
    {
      name: 'create_github_issue',
      description: `Create a new GitHub issue. IMPORTANT: Always use this tool when asked to create, file, log, or track an issue, bug, or task in GitHub. Requires human approval before execution.`,
      input_schema: {
        type: 'object',
        properties: {
          owner:  { type: 'string', description: 'GitHub owner or org' },
          repo:   { type: 'string', description: 'Repository name' },
          title:  { type: 'string', description: 'Issue title — clear and concise' },
          body:   { type: 'string', description: 'Issue body — markdown, include context and steps to reproduce if applicable' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Optional labels e.g. ["bug", "priority:high"]' },
        },
        required: ['owner', 'repo', 'title', 'body'],
      },
    },
    {
      name: 'post_slack_message',
      description: `Post a message to a Slack channel. IMPORTANT: Always use this tool when asked to post, send, notify, or share something in Slack. Requires human approval before execution.`,
      input_schema: {
        type: 'object',
        properties: {
          channel_id:   { type: 'string', description: 'Slack channel ID' },
          channel_name: { type: 'string', description: 'Channel name for display' },
          text:         { type: 'string', description: 'Message text — markdown supported' },
        },
        required: ['channel_id', 'channel_name', 'text'],
      },
    },
  ];
}

// ── Read tool executor ────────────────────────────────────────────────────────

export async function executeTool(toolName, toolInput, tokens) {
  switch (toolName) {
    case 'search_github_repo': {
      const { owner, repo } = toolInput;
      if (!tokens.github) return 'GitHub is not connected. Ask the user to connect GitHub.';
      try {
        const sources = await fetchGitHubSources(owner, repo, tokens.github);
        return sources.map(s => `### ${s.name}\n${s.content}`).join('\n\n---\n\n');
      } catch (err) {
        return `Error fetching ${owner}/${repo}: ${err.message}`;
      }
    }
    case 'read_slack_channel': {
      const { channel_id, channel_name } = toolInput;
      if (!tokens.slack) return 'Slack is not connected. Ask the user to connect Slack.';
      try {
        const source = await fetchChannelMessages(tokens.slack, channel_id, channel_name);
        return source.content;
      } catch (err) {
        return `Error reading ${channel_name}: ${err.message}`;
      }
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ── Write tool executor (called after human approval) ─────────────────────────

export async function executeWriteTool(toolName, toolInput, tokens) {
  switch (toolName) {

    case 'create_github_issue': {
      const { owner, repo, title, body, labels = [] } = toolInput;
      if (!tokens.github) throw new Error('GitHub not connected');
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
        method:  'POST',
        headers: {
          Authorization: `Bearer ${tokens.github}`,
          Accept:        'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title, body, labels }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `GitHub error ${res.status}`);
      return { url: data.html_url, number: data.number, title: data.title };
    }

    case 'post_slack_message': {
      const { channel_id, text } = toolInput;
      if (!tokens.slack) throw new Error('Slack not connected');
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${tokens.slack}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel: channel_id, text, mrkdwn: true }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(`Slack error: ${data.error}`);
      return { ts: data.ts, channel: data.channel };
    }

    default:
      throw new Error(`Unknown write tool: ${toolName}`);
  }
}