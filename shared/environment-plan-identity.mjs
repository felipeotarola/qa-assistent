// Pure JSON contract shared by the app and the VPS. Only execution fields,
// never secret values, prose, process IDs or changing health observations.
export function environmentPlanIdentity(value) {
  const invalid = () => { throw new Error('Invalid approved environment plan'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const repoUrl = typeof value.repoUrl === 'string' ? value.repoUrl.replace(/\/$/, '').replace(/\.git$/, '') : '';
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repoUrl) || repoUrl.split('/').some(part => part === '.' || part === '..')) invalid();
  for (const path of [value.root, value.directory]) if (typeof path !== 'string' || !/^\/workspace\/[\w./-]+$/.test(path) || path.split('/').includes('..')) invalid();
  if (value.directory !== value.root && !value.directory.startsWith(value.root + '/')) invalid();
  if (typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit) || typeof value.command !== 'string' || !value.command.trim() || value.command.length > 2000 || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) invalid();
  const reserved = /^(?:PATH|HOME|SHELL|BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|JAVA_TOOL_OPTIONS|GIT_.*|npm_config_.*)$/i;
  if (!Array.isArray(value.variables) || value.variables.length > 30 || value.variables.some(v => !v || typeof v.name !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(v.name) || reserved.test(v.name) || typeof v.required !== 'boolean') || new Set(value.variables.map(v => v.name)).size !== value.variables.length) invalid();
  const profile = value.executionProfile;
  if (profile !== undefined) {
    const keys = ['version', 'runtime', 'imageDigest', 'packageManager', 'packageManagerVersion', 'installDirectory', 'lockfile', 'lockfileSha256', 'ignoreScripts'];
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || Object.keys(profile).length !== keys.length || Object.keys(profile).some(key => !keys.includes(key)) || profile.version !== 1 || profile.runtime !== 'node24' || typeof profile.imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(profile.imageDigest) || !['npm', 'pnpm'].includes(profile.packageManager) || typeof profile.packageManagerVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(profile.packageManagerVersion) || typeof profile.installDirectory !== 'string' || !/^\/workspace\/[\w./-]+$/.test(profile.installDirectory) || profile.installDirectory.split('/').includes('..') || !(profile.installDirectory === value.root || profile.installDirectory.startsWith(value.root + '/')) || !(value.directory === profile.installDirectory || value.directory.startsWith(profile.installDirectory + '/')) || profile.lockfile !== (profile.packageManager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml') || typeof profile.lockfileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(profile.lockfileSha256) || profile.ignoreScripts !== true) invalid();
  }
  return { version: 1, repoUrl, root: value.root, directory: value.directory, commit: value.commit, command: value.command, port: value.port,
    variables: value.variables.map(({ name, required }) => ({ name, required })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    ...(profile === undefined ? {} : { executionProfile: { version: 1, runtime: 'node24', imageDigest: profile.imageDigest, packageManager: profile.packageManager, packageManagerVersion: profile.packageManagerVersion, installDirectory: profile.installDirectory, lockfile: profile.lockfile, lockfileSha256: profile.lockfileSha256, ignoreScripts: true } }) };
}

export function canonicalEnvironmentPlan(value) { return JSON.stringify(environmentPlanIdentity(value)); }
