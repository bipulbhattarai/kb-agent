const SLACK_TIMEOUT_MS = 10_000;

async function slackFetch(path, token, params = {}) {
  const url = new URL(`https://slack.com/api/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Slack API timed out');
    throw new Error('Cannot reach Slack API — check your internet connection');
  }
  clearTimeout(timer);

  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data;
}

// Fetch list of public channels the bot has access to
export async function fetchSlackChannels(token) {
  const data = await slackFetch('conversations.list', token, {
    types:            'public_channel,private_channel',
    exclude_archived: true,
    limit:            100,
  });
  return data.channels.map(c => ({
    id:   c.id,
    name: `#${c.name}`,
    memberCount: c.num_members,
  }));
}

// Fetch recent messages from a channel (last 50)
export async function fetchChannelMessages(token, channelId, channelName) {
  const data = await slackFetch('conversations.history', token, {
    channel: channelId,
    limit:   50,
  });

  // Resolve user IDs to display names
  const userIds = [...new Set(data.messages.filter(m => m.user).map(m => m.user))];
  const userMap = {};
  await Promise.all(userIds.slice(0, 20).map(async uid => {
    try {
      const u = await slackFetch('users.info', token, { user: uid });
      userMap[uid] = u.user.real_name || u.user.name;
    } catch { userMap[uid] = uid; }
  }));

  const lines = data.messages
    .filter(m => m.type === 'message' && m.text && !m.subtype)
    .reverse()
    .map(m => {
      const name = userMap[m.user] || 'Unknown';
      const ts   = new Date(parseFloat(m.ts) * 1000).toLocaleDateString();
      return `${name} [${ts}]: ${m.text}`;
    });

  return {
    id:      channelId,
    name:    channelName,
    content: `# ${channelName} (last ${lines.length} messages)\n\n${lines.join('\n')}`,
  };
}