import 'dotenv/config';
import express      from 'express';
import cors         from 'cors';
import session      from 'express-session';
import { fetchGitHubSources }                          from './github.js';
import { askAgent }                                    from './agent.js';
import { githubAuthUrl, githubExchangeCode, githubGetUser,
         slackAuthUrl,  slackExchangeCode }            from './Auth.js';
import { fetchSlackChannels, fetchChannelMessages }    from './Slack.js';
import { listMemories, deleteMemory }                  from './memory.js';
import { executeWriteTool }                            from './tools.js';
import { runTaskQueue }                                from './taskqueue.js';

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret:            process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave:            false,
  saveUninitialized: false,
  cookie:            { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(express.static('public'));

app.get('/api/health', (req, res) => {
  res.json({
    ok:          true,
    anthropic:   (process.env.ANTHROPIC_API_KEY || '').startsWith('sk-ant-'),
    githubOAuth: !!process.env.GITHUB_CLIENT_ID && !!process.env.GITHUB_CLIENT_SECRET,
    slackOAuth:  !!process.env.SLACK_CLIENT_ID  && !!process.env.SLACK_CLIENT_SECRET,
    githubUser:  req.session.github?.login || null,
    slackTeam:   req.session.slack?.team   || null,
  });
});

app.get('/auth/github', (req, res) => {
  if (!process.env.GITHUB_CLIENT_ID) return res.status(500).send('GITHUB_CLIENT_ID not set');
  res.redirect(githubAuthUrl());
});

app.get('/auth/github/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect(`/?error=github_${error || 'no_code'}`);
  try {
    const token = await githubExchangeCode(code);
    const user  = await githubGetUser(token);
    req.session.github = { token, login: user.login, avatar: user.avatar_url };
    res.redirect('/?connected=github');
  } catch (err) {
    console.error('[auth] GitHub:', err.message);
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

app.get('/auth/github/disconnect', (req, res) => { delete req.session.github; res.redirect('/'); });

app.get('/auth/slack', (req, res) => {
  if (!process.env.SLACK_CLIENT_ID) return res.status(500).send('SLACK_CLIENT_ID not set');
  res.redirect(slackAuthUrl());
});

app.get('/auth/slack/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect(`/?error=slack_${error || 'no_code'}`);
  try {
    const data = await slackExchangeCode(code);
    req.session.slack = { token: data.token, team: data.team, teamId: data.teamId };
    res.redirect('/?connected=slack');
  } catch (err) {
    console.error('[auth] Slack:', err.message);
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

app.get('/auth/slack/disconnect', (req, res) => { delete req.session.slack; res.redirect('/'); });

// ── GitHub repo list ──────────────────────────────────────────────────────────
app.get('/api/github/repos', async (req, res) => {
  const token = req.session.github?.token;
  if (!token) return res.status(401).json({ error: 'GitHub not connected' });
  try {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
    const [userRes, orgRes] = await Promise.all([
      fetch('https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator', { headers }),
      fetch('https://api.github.com/user/orgs', { headers }),
    ]);
    const userRepos = userRes.ok ? await userRes.json() : [];
    const orgs      = orgRes.ok  ? await orgRes.json()  : [];

    const orgRepos = (await Promise.all(
      orgs.slice(0, 5).map(org =>
        fetch(`https://api.github.com/orgs/${org.login}/repos?per_page=50&sort=updated`, { headers })
          .then(r => r.ok ? r.json() : [])
      )
    )).flat();

    const unique = Array.from(
      new Map([...userRepos, ...orgRepos].map(r => [r.full_name, r])).values()
    ).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    res.json({
      repos: unique.map(r => ({
        fullName:    r.full_name,
        owner:       r.owner.login,
        name:        r.name,
        description: r.description || '',
        private:     r.private,
        language:    r.language || '',
        updatedAt:   r.updated_at,
      })),
    });
  } catch (err) {
    console.error('[github] repos list:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/github/sources', async (req, res) => {
  const token = req.session.github?.token;
  if (!token) return res.status(401).json({ error: 'GitHub not connected — click Connect GitHub' });
  const { owner, repo } = req.query;
  if (!owner || !repo) return res.status(400).json({ error: 'owner and repo are required' });
  try {
    const sources = await fetchGitHubSources(owner, repo, token);
    res.json({ sources });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : err.message.includes('rate limit') ? 429 : 500;
    console.error(`[github] ${err.message}`);
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/slack/channels', async (req, res) => {
  const token = req.session.slack?.token;
  if (!token) return res.status(401).json({ error: 'Slack not connected — click Connect Slack' });
  try {
    const channels = await fetchSlackChannels(token);
    res.json({ channels });
  } catch (err) {
    console.error(`[slack] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/slack/messages', async (req, res) => {
  const token = req.session.slack?.token;
  if (!token) return res.status(401).json({ error: 'Slack not connected' });
  const { channelId, channelName } = req.query;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  try {
    const source = await fetchChannelMessages(token, channelId, channelName || channelId);
    res.json({ source });
  } catch (err) {
    console.error(`[slack] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { messages, connectedSources } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages array required' });

  // Pass OAuth tokens from session — never from the browser
  const tokens = {
    github: req.session.github?.token || null,
    slack:  req.session.slack?.token  || null,
  };

  try {
    const { reply, toolCalls, plan, memoriesUsed, reflection, pendingAction } = await askAgent(messages, connectedSources || {}, tokens);

    // Store pending write action in session so /api/approve can execute it securely
    if (pendingAction) {
      req.session.pendingAction = { ...pendingAction, storedAt: Date.now() };
      // Explicitly save session before responding so it's available for /api/approve
      await new Promise((resolve, reject) =>
        req.session.save(err => err ? reject(err) : resolve())
      );
    }

    res.json({ reply, toolCalls, plan, memoriesUsed, reflection, pendingAction: pendingAction ? { tool: pendingAction.tool, input: pendingAction.input, description: pendingAction.description } : null });
  } catch (err) {
    const status = err.message.includes('invalid') ? 401
      : err.message.includes('rate limit') ? 429
      : err.message.includes('timed out')  ? 504 : 500;
    console.error(`[agent] ${err.message}`);
    res.status(status).json({ error: err.message });
  }
});

// ── Task queue (SSE streaming) ────────────────────────────────────────────────
app.post('/api/tasks', async (req, res) => {
  const { request, connectedSources } = req.body;
  if (!request) return res.status(400).json({ error: 'request is required' });

  const tokens = {
    github: req.session.github?.token || null,
    slack:  req.session.slack?.token  || null,
  };

  // Set up SSE
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  await runTaskQueue(request, connectedSources || {}, tokens, res);
});

// ── Human-in-the-loop: Approve ────────────────────────────────────────────────
app.post('/api/approve', async (req, res) => {
  const pending = req.session.pendingAction;
  if (!pending) return res.status(400).json({ error: 'No pending action found' });

  const tokens = {
    github: req.session.github?.token || null,
    slack:  req.session.slack?.token  || null,
  };

  try {
    // Allow frontend to send edited input
    const input  = req.body.input || pending.input;
    const result = await executeWriteTool(pending.tool, input, tokens);
    delete req.session.pendingAction;
    console.log(`[hitl] Approved and executed: ${pending.tool}`);
    res.json({ result, tool: pending.tool });
  } catch (err) {
    console.error(`[hitl] Execution failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Human-in-the-loop: Reject ─────────────────────────────────────────────────
app.post('/api/reject', (req, res) => {
  const pending = req.session.pendingAction;
  if (!pending) return res.status(400).json({ error: 'No pending action found' });
  console.log(`[hitl] Rejected: ${pending.tool}`);
  delete req.session.pendingAction;
  res.json({ rejected: true, tool: pending.tool });
});

// ── Memory ────────────────────────────────────────────────────────────────────
app.get('/api/memory', async (_req, res) => {
  try   { res.json({ memories: await listMemories() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/memory/:id', async (req, res) => {
  try   { res.json({ deleted: await deleteMemory(Number(req.params.id)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled:', err);
  res.status(500).json({ error: 'Unexpected server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀  KB Agent → http://localhost:${PORT}\n`);
  [
    ['Anthropic key',    (process.env.ANTHROPIC_API_KEY||'').startsWith('sk-ant-')],
    ['GitHub Client ID', !!process.env.GITHUB_CLIENT_ID],
    ['GitHub Secret',    !!process.env.GITHUB_CLIENT_SECRET],
    ['Slack Client ID',  !!process.env.SLACK_CLIENT_ID],
    ['Slack Secret',     !!process.env.SLACK_CLIENT_SECRET],
  ].forEach(([l,ok]) => console.log(`   ${ok?'✓':'✗'} ${l}${ok?'':' — add to .env'}`));
  console.log();
});