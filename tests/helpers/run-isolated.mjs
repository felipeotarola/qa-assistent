import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { readIsolationFixture, isolatedProcessEnvironment } from './autonomy-isolation.mjs';

const test = resolve(process.argv[2] || '');
const within = relative(resolve('tests'), test);
if (!within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`) || !test.endsWith('.mjs')) throw new Error('Choose an integration script inside tests/');
const fixture = await readIsolationFixture();
const env = isolatedProcessEnvironment(fixture);
env.SYNA_TEST_DATABASE_URL = fixture.databaseUrl;
const child = spawn(process.execPath, [test, ...process.argv.slice(3)], { env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { throw error; });
child.on('exit', code => { process.exitCode = code ?? 1; });
