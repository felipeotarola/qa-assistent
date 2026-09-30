// Executed inside the isolated checkout. No project code or lifecycle hooks run.
export function inspectRepository() {
  const fs = require('node:fs'), path = require('node:path');
  const root = fs.realpathSync(process.cwd()), projects = [];
  let visited = 0;
  function scan(directory, depth) {
    if (++visited > 1000 || projects.length >= 30) return;
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    const files = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name));
    const relative = path.relative(root, directory).split(path.sep).join('/') || '.';
    if (files.has('package.json')) {
      const file = path.join(directory, 'package.json');
      if (fs.statSync(file).size < 128000) {
        try {
          const p = JSON.parse(fs.readFileSync(file, 'utf8'));
          projects.push({ directory: relative, kind: 'node', name: p.name, scripts: p.scripts || {}, packageManager: p.packageManager || null, engines: p.engines || {}, nextVersion: p.dependencies?.next || p.devDependencies?.next || null, lock: files.has('package-lock.json'), pnpmLock: files.has('pnpm-lock.yaml') });
        } catch { projects.push({ directory: relative, kind: 'invalid', reason: 'Invalid package.json' }); }
      }
    } else if (files.has('pom.xml')) projects.push({ directory: relative, kind: 'java', buildSystem: 'maven', wrapper: files.has('mvnw') });
    else if (files.has('build.gradle') || files.has('build.gradle.kts')) projects.push({ directory: relative, kind: 'java', buildSystem: 'gradle', wrapper: files.has('gradlew') });
    else if (files.has('pyproject.toml') || files.has('requirements.txt') || files.has('pytest.ini')) projects.push({ directory: relative, kind: 'python', requirements: files.has('requirements.txt'), pyproject: files.has('pyproject.toml') });
    if (depth >= 4) return;
    for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'vendor', 'build', 'dist', 'target', '__pycache__'].includes(entry.name)) scan(path.join(directory, entry.name), depth + 1);
  }
  scan(root, 0); return { projects, truncated: visited > 1000 || projects.length >= 30 };
}

export const inspectionCommand = `console.log(JSON.stringify((${inspectRepository.toString()})()))`;

export function executionPlan(metadata, request) {
  const projects = metadata.projects || [{ ...metadata, directory: '.', kind: 'node' }];
  const project = request.directory ? projects.find(p => p.directory === request.directory) : projects.find(p => p.directory === '.') || (projects.length === 1 ? projects[0] : null);
  if (!project) throw new Error(projects.length ? `Välj projektkatalog: ${projects.map(p => p.directory).join(', ')}.` : 'Inget stödd projekt hittades. Behöver Node, Java eller Python med en projektfil.');
  const plan = { directory: project.directory, runtime: '', operationKind: 'test', selectedScript: request.script, install: [], command: [], project };
  if (project.kind === 'node') {
    const engine = project.engines?.node || '';
    if (/^(?:\^|~)?22(?:\.0(?:\.0)?)?(?:\.x)?$/.test(engine)) plan.runtime = 'node22';
    else if (!engine || /^(?:\^|~)?24(?:\.0(?:\.0)?)?(?:\.x)?$/.test(engine) || /^>=\s*(?:1[468]|2[024])(?:\.0(?:\.0)?)?$/.test(engine)) plan.runtime = 'node24';
    else throw new Error(`Node-versionen ${engine} behöver en vald miljöprofil. Tillgängligt: Node 22 och 24.`);
    const selected = request.script === 'auto' ? ['test', 'test:unit', 'typecheck', 'lint'].find(s => Object.hasOwn(project.scripts, s)) : Object.hasOwn(project.scripts, request.script) ? request.script : null;
    if (!selected && request.mode !== 'inspect') throw new Error(`Inget körbart script hittades. Tillgängliga scripts: ${Object.keys(project.scripts).join(', ') || 'inga'}. Inga tester har körts.`);
    plan.selectedScript = selected || request.script;
    plan.operationKind = ['typecheck', 'lint'].includes(selected) ? 'static-check' : selected === 'build' ? 'build' : 'test';
    if (request.mode !== 'inspect') {
      if (['dev', 'start', 'serve'].includes(selected)) throw new Error('Detta script startar en långlivad tjänst. Använd Eve-sandboxen för appstart, verifiera HTTP-svaret och öppna sedan preview. Repository-jobb städas efter körningen.');
      const nextMajor = String(project.nextVersion || '').match(/^[~^]?(\d+)\.\d+\.\d+(?:-[\w.-]+)?$/)?.[1];
      if (Number(nextMajor) >= 16 && /^\s*next\s+lint(?:\s|$)/.test(project.scripts[selected] || '')) throw new Error(`Scriptet ${selected} använder next lint som togs bort i Next.js 16 (projektet anger ${project.nextVersion}). Uppdatera repots lint-script till ESLint eller Biome. Ingen tjänst har startats och inga tester har körts. För att visa appen: använd dev-scriptet i Eve-sandboxen och sedan preview.`);
    }
    const manager = project.packageManager;
    if (manager?.startsWith('pnpm@')) {
      if (!/^pnpm@\d+\.\d+\.\d+(?:\+sha\d+\.[a-f0-9]+)?$/.test(manager) || !project.pnpmLock) throw new Error('pnpm kräver en exakt version och pnpm-lock.yaml.');
      const version = manager.split('+')[0];
      const bin = version === 'pnpm@10.33.4' ? ['pnpm'] : ['npm', 'exec', '--yes', '--ignore-scripts', `--package=${version}`, '--', 'pnpm'];
      plan.install = [[...bin, 'install', '--frozen-lockfile', '--ignore-scripts']];
      plan.command = [...bin, '--config.enable-pre-post-scripts=false', 'run', plan.selectedScript, ...(request.args || [])];
    } else {
      if (manager && !manager.startsWith('npm@')) throw new Error(`Pakethanteraren ${manager} behöver en miljöprofil. npm och pnpm stöds.`);
      plan.install = [['npm', project.lock ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund']];
      plan.command = ['npm', '--ignore-scripts', 'run', plan.selectedScript, '--', ...(request.args || [])];
    }
  } else if (project.kind === 'java') {
    plan.runtime = 'java21'; plan.selectedScript = request.script === 'auto' ? 'test' : request.script;
    if (plan.selectedScript !== 'test') throw new Error('Java-profilen kör test. Använd sandbox för andra explicita byggkommandon.');
    if (project.buildSystem === 'gradle' && !project.wrapper) throw new Error('Gradle-projektet behöver en gradlew-wrapper för reproducerbar körning.');
    plan.command = project.buildSystem === 'gradle' ? ['sh', './gradlew', '--gradle-user-home', '/workspace/.gradle', '--no-daemon', 'test', ...(request.args || [])] : [...(project.wrapper ? ['sh', './mvnw'] : ['mvn']), '-B', '-Dmaven.repo.local=/workspace/.m2/repository', 'test', ...(request.args || [])];
  } else if (project.kind === 'python') {
    plan.runtime = 'python3'; plan.selectedScript = request.script === 'auto' ? 'test' : request.script;
    if (plan.selectedScript !== 'test') throw new Error('Python-profilen kör pytest. Använd sandbox för andra explicita kommandon.');
    plan.install = [['python3', '-m', 'venv', '/workspace/venv'], ['/workspace/venv/bin/pip', 'install', 'pytest'], ...(project.requirements ? [['/workspace/venv/bin/pip', 'install', '-r', 'requirements.txt']] : project.pyproject ? [['/workspace/venv/bin/pip', 'install', '.']] : [])];
    plan.command = ['/workspace/venv/bin/python', '-m', 'pytest', ...(request.args || [])];
  } else throw new Error('Projektfilen kunde inte läsas. Kontrollera projektets konfiguration.');
  if (request.mode === 'inspect') plan.operationKind = 'inspect';
  return plan;
}
