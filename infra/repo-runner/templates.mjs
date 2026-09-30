import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';

// Trusted Eve build resources only. No commands or user credentials in templates.
export class SandboxTemplates {
  constructor(directory) { this.directory = directory; }
  path(key) {
    if (typeof key !== 'string' || !/^[\w.-]{1,160}$/.test(key)) throw new Error('Invalid sandbox template key');
    return `${this.directory}/${createHash('sha256').update(key).digest('hex')}.json`;
  }
  async get(key) {
    try { return JSON.parse(await readFile(this.path(key), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('Sandbox template is not provisioned. Deploy the Eve build first.', { cause: error }); throw error; }
  }
  async put(key, files) {
    const file = this.path(key), seen = new Set(); let bytes = 0;
    if (!Array.isArray(files) || files.length > 200) throw new Error('Invalid sandbox seed files');
    for (const seed of files) {
      if (!seed || typeof seed.path !== 'string' || seed.path.length > 500 || seed.path.startsWith('/') || seed.path.includes('\\') || seed.path.includes('\0') || seed.path.split('/').some(p => !p || p === '.' || p === '..') || seen.has(seed.path)) throw new Error('Invalid sandbox seed path');
      if (typeof seed.data !== 'string' || Buffer.from(seed.data, 'base64').toString('base64') !== seed.data) throw new Error('Invalid sandbox seed content');
      seen.add(seed.path); bytes += seed.data.length;
    }
    if (bytes > 3000000) throw new Error('Sandbox seed files exceed 3 MB');
    const content = JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, content, { mode: 0o600 });
    try {
      try { await link(temp, file); return { reused: false }; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await readFile(file, 'utf8') !== content) throw new Error('Sandbox template key already contains different files', { cause: error });
        return { reused: true };
      }
    } finally { await unlink(temp); }
  }
}

// Executed as the sandbox user. Retries never overwrite existing user files.
export const seedTemplateCommand = `const fs=require('node:fs'),path=require('node:path');
for(const seed of JSON.parse(fs.readFileSync(0,'utf8'))){
  let dir='/workspace'; const parts=seed.path.split('/');
  for(const part of parts.slice(0,-1)){
    dir=path.join(dir,part); try{fs.mkdirSync(dir)}catch(e){if(e.code!=='EEXIST')throw e}
    const info=fs.lstatSync(dir); if(info.isSymbolicLink()||!info.isDirectory())throw Error('Unsafe seed directory');
  }
  const file=path.join(dir,parts.at(-1));
  try{fs.writeFileSync(file,Buffer.from(seed.data,'base64'),{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e}
}`;
