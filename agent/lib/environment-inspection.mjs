// Serialized into a read-only Node command executed inside the caller's sandbox.
// Never import or execute code from the inspected repositories.
export function inspectEnvironment(root = '/workspace', load) {
  // Inject require inside the sandbox; bundlers otherwise rewrite it into an
  // application-only helper that does not exist in the serialized function.
  const fs = load('node:fs'), path = load('node:path'), { execFileSync } = load('node:child_process');
  root = fs.realpathSync(root);
  const result = { root, repositories: [], projects: [], processes: [], listeningTcpPorts: [], disk: null, truncated: false };
  const skipped = new Set(['node_modules', 'vendor', 'build', 'dist', 'target', '__pycache__']);
  let visited = 0;
  const inside = value => value === root || value.startsWith(root + path.sep);
  function read(file) { try { return fs.statSync(file).size < 128000 ? fs.readFileSync(file, 'utf8') : null; } catch { return null; } }
  function git(directory, args) {
    try { return execFileSync('git', ['--no-optional-locks', '-C', directory, ...args], { encoding: 'utf8', timeout: 1500, maxBuffer: 16000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim(); }
    catch { return null; }
  }
  function origin(value) {
    if (!value) return null;
    const ssh = value.match(/^git@([\w.-]+):([\w./-]+)$/);
    if (ssh) return `https://${ssh[1]}/${ssh[2].replace(/\.git$/, '')}`;
    try { const url = new URL(value); return ['http:', 'https:', 'ssh:'].includes(url.protocol) ? `https://${url.hostname}${url.pathname.replace(/\.git$/, '')}` : null; } catch { return null; }
  }
  function scan(directory, depth) {
    if (++visited > 600 || result.projects.length >= 24 || result.repositories.length >= 12) { result.truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { result.truncated = true; return; }
    const names = new Set(entries.map(entry => entry.name));
    if (names.has('.git')) {
      const status = git(directory, ['status', '--porcelain', '--untracked-files=normal']);
      result.repositories.push({ directory, origin: origin(git(directory, ['config', '--local', '--get', 'remote.origin.url'])), commit: git(directory, ['rev-parse', 'HEAD']), branch: git(directory, ['branch', '--show-current']), hasChanges: status === null ? null : !!status });
    }
    if (names.has('package.json')) {
      try {
        const source = read(path.join(directory, 'package.json'));
        if (source === null) throw new Error('Manifest unavailable');
        const manifest = JSON.parse(source);
        result.projects.push({ directory, name: typeof manifest.name === 'string' ? manifest.name.slice(0, 200) : null, scripts: Object.fromEntries(Object.entries(manifest.scripts || {}).filter(([, value]) => typeof value === 'string').slice(0, 20).map(([name, command]) => [name.slice(0, 100), command.slice(0, 400)])), packageManager: typeof manifest.packageManager === 'string' ? manifest.packageManager.slice(0, 100) : null, dependenciesPresent: names.has('node_modules'), lockfiles: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].filter(name => names.has(name)) });
      } catch { result.projects.push({ directory, error: 'Could not read package.json' }); }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || skipped.has(entry.name)) continue;
      if (depth >= 4) { result.truncated = true; continue; }
      scan(path.join(directory, entry.name), depth + 1);
    }
  }
  scan(root, 0);
  try { const disk = fs.statfsSync(root); result.disk = { totalBytes: disk.blocks * disk.bsize, availableBytes: disk.bavail * disk.bsize }; } catch { /* Optional on unsupported platforms. */ }
  try {
    for (const pid of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
      if (Number(pid) === process.pid) continue;
      try {
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (!inside(cwd)) continue;
        if (result.processes.length >= 40) { result.truncated = true; break; }
        // No argv or environment: either can contain tokens or credentials.
        result.processes.push({ pid: Number(pid), name: (read(`/proc/${pid}/comm`) || '').trim(), directory: cwd });
      } catch { /* Process exited or inaccessible. */ }
    }
    const ports = new Set();
    for (const name of ['tcp', 'tcp6']) for (const line of (read(`/proc/net/${name}`) || '').trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A') ports.add(parseInt(fields[1].split(':').at(-1), 16));
    }
    result.listeningTcpPorts = [...ports].filter(Number.isFinite).sort((a, b) => a - b);
  } catch { /* /proc is available in the Linux sandbox, optional for local tests. */ }
  // The process supervisor keeps a 32K-character tail. Preserve complete JSON
  // rather than allowing a large monorepo snapshot to be cut mid-document.
  while (JSON.stringify(result).length > 24000) {
    result.truncated = true;
    if (result.projects.length) result.projects.pop();
    else if (result.processes.length) result.processes.pop();
    else result.repositories.pop();
  }
  return result;
}

export function environmentInspectionCommand() {
  const source = `console.log(JSON.stringify((${inspectEnvironment.toString()})('/workspace', require)))`;
  return `node -e "eval(Buffer.from('${Buffer.from(source).toString('base64')}', 'base64').toString())"`;
}
