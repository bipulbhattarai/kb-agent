const GH_BASE       = 'https://api.github.com';
const GH_TIMEOUT_MS = 10_000;

// Extensions worth reading for code understanding
const CODE_EXTENSIONS = ['.go','.js','.ts','.py','.rb','.java','.rs','.cs','.cpp','.c','.jsx','.tsx','.vue','.swift','.kt'];
const SKIP_DIRS       = ['node_modules','vendor','.git','dist','build','__pycache__','.next'];

function ghHeaders(token) {
  const h = { Accept: 'application/vnd.github+json' };
  const t = token || process.env.GITHUB_TOKEN;
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

async function ghFetch(path, required = false, token = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${GH_BASE}${path}`, { headers: ghHeaders(token), signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`GitHub request timed out after ${GH_TIMEOUT_MS / 1000}s`);
    throw new Error('Cannot reach GitHub API — check your internet connection');
  }
  clearTimeout(timer);

  if (!res.ok) {
    if (!required) return null;
    switch (res.status) {
      case 401: throw new Error('GitHub token is invalid or expired — update GITHUB_TOKEN in .env');
      case 403: throw new Error('GitHub rate limit exceeded or token lacks permission');
      case 404: throw new Error('Repo not found — check owner/repo spelling or token access');
      case 422: throw new Error('GitHub rejected the request — repo may be empty');
      default:  throw new Error(`GitHub API error ${res.status} — ${res.statusText}`);
    }
  }
  return res.json();
}

async function fetchFileContent(owner, repo, path, token) {
  const file = await ghFetch(`/repos/${owner}/${repo}/contents/${path}`, false, token);
  if (!file?.content) return null;
  const raw = Buffer.from(file.content, 'base64').toString('utf-8');
  return raw.length > 3000 ? raw.slice(0, 3000) + '\n...[truncated]' : raw;
}

export async function fetchGitHubSources(owner, repo, token = null) {
  const sources = [];

  // 1. Repo metadata (required)
  const info = await ghFetch(`/repos/${owner}/${repo}`, true, token);
  sources.push({
    id: '__meta__', name: `${repo} — info`,
    content: [
      `Repo: ${info.full_name}`,
      `Description: ${info.description || 'n/a'}`,
      `Language: ${info.language || 'n/a'}`,
      `Stars: ${info.stargazers_count}`,
      `Default branch: ${info.default_branch}`,
      `Topics: ${(info.topics || []).join(', ') || 'none'}`,
    ].join('\n'),
  });

  // 2. File tree
  const tree = await ghFetch(`/repos/${owner}/${repo}/git/trees/${info.default_branch}?recursive=1`, false, token);
  const allFiles = tree ? (tree.tree || []).filter(f => f.type === 'blob').map(f => f.path) : [];

  if (allFiles.length) {
    sources.push({ id: '__tree__', name: `${repo} — file tree`, content: allFiles.slice(0, 150).join('\n') });
  }

  // 3. Standard doc files
  const docCandidates = [
    'README.md','readme.md','Readme.md','README.rst','README',
    'CONTRIBUTING.md','.github/CONTRIBUTING.md',
    'docs/README.md','docs/architecture.md','docs/setup.md',
    'docs/development.md','ARCHITECTURE.md','docs/index.md',
  ];

  let docsFound = 0;
  for (const path of docCandidates) {
    const content = await fetchFileContent(owner, repo, path, token);
    if (content) {
      sources.push({ id: path, name: path, content });
      docsFound++;
    }
  }

  // 4. Fallback: fetch actual source code files when no docs exist
  if (docsFound === 0 && allFiles.length) {
    console.log(`[github] No docs found in ${owner}/${repo} — fetching source code files instead`);

    // Pick the most useful source files: entry points first, then by extension
    const entryPatterns = ['main','index','app','server','cmd/main','main.go','index.js','app.py'];
    const sourceFiles   = allFiles.filter(f => {
      const inSkipDir = SKIP_DIRS.some(d => f.startsWith(d + '/'));
      const hasCodeExt = CODE_EXTENSIONS.some(e => f.endsWith(e));
      return !inSkipDir && hasCodeExt;
    });

    // Prioritise entry points
    const prioritised = [
      ...sourceFiles.filter(f => entryPatterns.some(p => f.toLowerCase().includes(p))),
      ...sourceFiles.filter(f => !entryPatterns.some(p => f.toLowerCase().includes(p))),
    ].slice(0, 8); // fetch up to 8 source files

    let codeFound = 0;
    for (const path of prioritised) {
      const content = await fetchFileContent(owner, repo, path, token);
      if (content) {
        sources.push({ id: path, name: path, content });
        codeFound++;
        if (codeFound >= 5) break; // cap at 5 to keep context manageable
      }
    }

    console.log(`[github] Loaded ${codeFound} source files from ${owner}/${repo}`);
  }

  return sources;
}