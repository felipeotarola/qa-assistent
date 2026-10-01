// Run with pnpm test:regression; --live opts into isolated API/VPS fixtures.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';

const live = process.argv.includes('--live');
const stages = [{ name: 'Unit contracts', args: ['--test', ...readdirSync('tests').filter(f => f.endsWith('.test.mjs')).map(f => `tests/${f}`)] }];
if (live) stages.push(
  { name: 'Run results and requirement API', file: 'test-runs.integration.mjs', env: { RUN_WORKSPACE_TESTS: '1', RUN_RELIABILITY_ONLY: '0' } },
  { name: 'Requirement transactions with two connections', file: 'test-requirements.integration.mjs', env: { RUN_WORKSPACE_TESTS: '1' } },
  { name: 'Missing configuration and vault API', file: 'project-environment.integration.mjs', env: { RUN_ENVIRONMENT_TESTS: '1', ENVIRONMENT_API_ONLY: '1' } },
  { name: 'VPS browser actions', file: 'browser.integration.mjs', env: { RUN_VPS_BROWSER_TESTS: '1', TEST_SURDEG_RELIABILITY: '1' } },
  { name: 'Iris to V, Surdeg complete/blocked coverage', file: 'browser-jobs.integration.mjs', env: { RUN_IRIS_TESTS: '1', TEST_SURDEG_RELIABILITY: '1' } },
  { name: 'Public repository and saved report', file: 'repositories.integration.mjs', env: { RUN_REPOSITORY_TESTS: '1', REPO_TEST_URL: 'https://github.com/sindresorhus/is-stream', REPO_TEST_SCRIPT: 'test', REPO_EXPECT_STATUS: 'passed' } },
);
for (const stage of stages) {
  console.log(`\nRegression: ${stage.name}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, stage.args ?? ['--env-file=.env', `tests/${stage.file}`], { stdio: 'inherit', env: { ...process.env, ...stage.env } });
    child.on('error', reject); child.on('exit', code => resolve(code ?? 1));
  });
  if (code !== 0) process.exit(code);
}
console.log(`PASS ${stages.length} regression stages${live ? '' : '; use --live for API/VPS verification'}`);
