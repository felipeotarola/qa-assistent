import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Runner, terminal } from './runner.mjs';
import { SandboxStorage } from '../execution/storage.mjs';

// Real Docker/gVisor/profile verification, with disposable source fixtures.
const root = await mkdtemp('/var/tmp/qa-runtime-smoke-');
const fixtures = [
  { runtime: 'java21', expected: 'passed', files: {
    'pom.xml': '<project><modelVersion>4.0.0</modelVersion><groupId>qa</groupId><artifactId>fixture</artifactId><version>1</version><properties><maven.compiler.release>21</maven.compiler.release></properties><build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.13.0</version></plugin><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.5.2</version></plugin></plugins></build><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency></dependencies></project>',
    'src/test/java/FixtureTest.java': 'import org.junit.Test; import static org.junit.Assert.*; public class FixtureTest { @Test public void addition(){ assertEquals(4,2+2); } }',
  } },
  { runtime: 'python3', expected: 'passed', files: { 'requirements.txt': '# No application dependencies', 'test_fixture.py': 'def test_addition():\n    assert 2 + 2 == 4\n' } },
  { name: 'gradle', runtime: 'java21', expected: 'passed', wrapper: true, files: {
    'settings.gradle': "rootProject.name = 'fixture'",
    'build.gradle': "plugins { id 'java' }; repositories { mavenCentral() }; dependencies { testImplementation 'junit:junit:4.13.2' }; tasks.withType(Test).configureEach { maxHeapSize = '128m' }",
    'gradle.properties': 'org.gradle.jvmargs=-Xmx384m -XX:MaxMetaspaceSize=256m\norg.gradle.workers.max=1\n',
    'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip\n',
    'src/test/java/FixtureTest.java': 'import org.junit.Test; import static org.junit.Assert.*; public class FixtureTest { @Test public void addition(){ assertEquals(4,2+2); } }',
  } },
  { runtime: 'node24', expected: 'failed', files: { 'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node --test' } }), 'test.mjs': "import test from 'node:test';import assert from 'node:assert/strict';test('required configuration',()=>assert.ok(process.env.FIXTURE_REQUIRED_VALUE,'Missing FIXTURE_REQUIRED_VALUE'));" } },
];
try {
  for (const fixture of fixtures) {
    if (process.env.RUNTIME_SMOKE_ONLY && (fixture.name || fixture.runtime) !== process.env.RUNTIME_SMOKE_ONLY) continue;
    if (fixture.wrapper) {
      for (const file of ['gradlew', 'gradle/wrapper/gradle-wrapper.jar']) {
        const response = await fetch(`https://raw.githubusercontent.com/gradle/gradle/v8.14.3/${file}`, { signal: AbortSignal.timeout(30000) });
        assert.ok(response.ok, `Official Gradle wrapper ${file}: ${response.status}`);
        fixture.files[file] = { base64: Buffer.from(await response.arrayBuffer()).toString('base64') };
      }
    }
    const directory = `${root}/${fixture.name || fixture.runtime}`;
    const runner = new Runner({ directory, timeoutMs: 240000, storage: new SandboxStorage(`${directory}/disks`, 4), fixture: async (name, execute) => {
      const source = `const fs=require('fs'),cp=require('child_process');fs.mkdirSync('/workspace/repo',{recursive:true});process.chdir('/workspace/repo');for(const [p,s]of Object.entries(${JSON.stringify(fixture.files)})){fs.mkdirSync(require('path').dirname(p),{recursive:true});fs.writeFileSync(p,typeof s==='string'?s:Buffer.from(s.base64,'base64'))};for(const args of [['init'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-m','fixture']])cp.execFileSync('git',args);`;
      assert.equal((await execute(['exec', name, 'node', '-e', source])).code, 0);
    } });
    await runner.init();
    const job = await runner.submit({ id: randomUUID(), url: 'https://github.com/example/fixture', mode: 'test', script: 'auto' });
    const until = Date.now() + 300000;
    while (!terminal(job.status)) { assert.ok(Date.now() < until, 'Runtime fixture timed out'); await new Promise(resolve => setTimeout(resolve, 500)); }
    assert.equal(job.status, fixture.expected, job.message + '\n' + job.logs.slice(-4000));
    assert.equal(job.plan.runtime, fixture.runtime);
    console.log(`PASS ${fixture.runtime}: ${job.status}; ${job.logs.slice(-1400)}`);
  }
} finally { await rm(root, { recursive: true, force: true }); }
