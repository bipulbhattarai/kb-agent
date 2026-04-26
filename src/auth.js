// ── GitHub OAuth ──────────────────────────────────────────────────────────────

export function githubAuthUrl() {
  const params = new URLSearchParams({
    client_id:    process.env.GITHUB_CLIENT_ID,
    redirect_uri: process.env.GITHUB_CALLBACK_URL,
    scope:        'repo read:org',
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function githubExchangeCode(code) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri:  process.env.GITHUB_CALLBACK_URL,
    }),
  });
  const data = await res.json();
  if (data.error)       throw new Error(`GitHub OAuth error: ${data.error_description}`);
  if (!data.access_token) throw new Error('GitHub did not return an access token');
  return data.access_token;
}

export async function githubGetUser(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error('Failed to fetch GitHub user info');
  return res.json();
}

// ── Slack OAuth ───────────────────────────────────────────────────────────────

export function slackAuthUrl() {
  const params = new URLSearchParams({
    client_id:    process.env.SLACK_CLIENT_ID,
    redirect_uri: process.env.SLACK_CALLBACK_URL,
    scope:        'channels:read,channels:history,groups:read,groups:history',
  });
  return `https://slack.com/oauth/v2/authorize?${params}`;
}

export async function slackExchangeCode(code) {
  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri:  process.env.SLACK_CALLBACK_URL,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack OAuth error: ${data.error}`);
  return {
    token:  data.access_token,
    teamId: data.team?.id,
    team:   data.team?.name,
  };
}