import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { missionAdmissionSchema, missionIntakeAdmissionSchema, missionControlActionSchema, missionTaskSpecSchema } from '../shared/mission-control.ts';

const target = { kind: 'repository', url: 'https://github.com/example/library', ref: 'a'.repeat(40) };
const input = (target, goal) => ({ requestId: randomUUID(), intent: 'explore', goal, target });

test('canonical stored targets keep omitted surface as checks for object and serialized data', () => {
  for (const value of [target, JSON.stringify(target)]) {
    const admitted = missionAdmissionSchema.parse(input(value, 'Testa bibliotekets viktigaste funktioner. Ändra ingen kod.'));
    assert.deepEqual(admitted.target, { ...target, surface: 'checks' });
    const discovery = missionTaskSpecSchema.parse({ kind: 'discovery', target: admitted.target });
    assert.equal(discovery.target.surface, 'checks');
  }
});

test('an explicit app/browser request retains application through intake and discovery', () => {
  const application = { ...target, surface: 'application' };
  for (const value of [application, JSON.stringify(application)]) {
    const admitted = missionAdmissionSchema.parse(input(value, 'Starta appen och testa navigeringen. Repot har också npm test.'));
    assert.deepEqual(admitted.target, application);
    assert.deepEqual(missionTaskSpecSchema.parse({ kind: 'discovery', target: admitted.target }).target, application);
  }
});

test('canonical scope parsing does not infer or override an explicit surface from prose', () => {
  const goal = 'Testa bibliotekets funktioner';
  // The witnessed wrong model choice remains observable. Instructions do not
  // secretly rewrite the user's admitted scope; model routing needs real evals.
  assert.equal(missionAdmissionSchema.parse(input({ ...target, surface: 'application' }, goal)).target.surface, 'application');
  assert.equal(missionAdmissionSchema.parse(input({ ...target, surface: 'auto' }, goal)).target.surface, 'auto');
  assert.equal(missionAdmissionSchema.parse(input(target, 'Starta appen')).target.surface, 'checks');
});


test('only new intake defaults an unspecified general repository surface to auto', () => {
  for (const value of [target, JSON.stringify(target)]) {
    const parsed = missionIntakeAdmissionSchema.parse(input(value, 'Förbered repot och testa det som går.'));
    assert.equal(parsed.target.surface, 'auto');
    assert.equal(missionControlActionSchema.parse({ action: 'accept', ...input(value, 'Granska och testa projektet.') }).target.surface, 'auto');
    assert.equal(missionAdmissionSchema.parse(parsed).target.surface, 'auto');
    assert.equal(missionTaskSpecSchema.parse({ kind: 'discovery', target: parsed.target }).target.surface, 'auto');
  }
  for (const surface of ['checks', 'application']) {
    assert.equal(missionIntakeAdmissionSchema.parse(input({ ...target, surface }, 'Testa projektet')).target.surface, surface);
  }
  assert.equal(missionIntakeAdmissionSchema.safeParse(input({ ...target, surface: 'guess' }, 'Testa projektet')).success, false);
});
