import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolveCodexAccess, canUseCodex } from '../infra/codex-worker/access.mjs';
import codexInstructions from '../agent/instructions/codex.ts';

test('unconfigured access preserves a valid legacy pilot and otherwise stays disabled', () => {
  const pilotUserId = randomUUID();
  for (const mode of [undefined, '']) {
    const legacy = resolveCodexAccess(mode, pilotUserId);
    assert.equal(legacy.mode, 'pilot');
    assert.equal(legacy.pilotUserId, pilotUserId);
    assert.equal(canUseCodex(pilotUserId, legacy), true);
    assert.equal(canUseCodex(randomUUID(), legacy), false);
    for (const missingPilot of [undefined, '', 'not-a-user-id', 'user@example.com']) {
      const access = resolveCodexAccess(mode, missingPilot);
      assert.equal(access.mode, 'disabled');
      assert.equal(canUseCodex(randomUUID(), access), false);
    }
  }
});

test('explicit shared mode admits independent authenticated UUID identities and ignores legacy restriction', () => {
  const firstUser = randomUUID(), secondUser = randomUUID();
  const access = resolveCodexAccess('shared', firstUser);
  assert.equal(access.mode, 'shared');
  assert.equal(canUseCodex(firstUser, access), true);
  assert.equal(canUseCodex(secondUser, access), true);
  for (const principal of [undefined, null, '', 'anonymous', 'user@example.com', 123, {}, `${secondUser} `]) {
    assert.equal(canUseCodex(principal, access), false);
  }
});

test('disabled and unknown modes override a configured legacy pilot', () => {
  const pilotUserId = randomUUID();
  for (const mode of ['disabled', 'shraed', '*', 'all', 'true']) {
    const access = resolveCodexAccess(mode, pilotUserId);
    assert.equal(access.mode, 'disabled');
    assert.equal(canUseCodex(pilotUserId, access), false);
    assert.equal(canUseCodex(randomUUID(), access), false);
  }
});

test('explicit pilot mode requires one valid matching identity', () => {
  const pilotUserId = randomUUID();
  const access = resolveCodexAccess('pilot', pilotUserId);
  assert.equal(canUseCodex(pilotUserId, access), true);
  assert.equal(canUseCodex(randomUUID(), access), false);
  for (const invalidPilot of [undefined, '', 'not-a-uuid']) {
    const disabled = resolveCodexAccess('pilot', invalidPilot);
    assert.equal(disabled.mode, 'disabled');
    assert.equal(canUseCodex(pilotUserId, disabled), false);
  }
});

test('live turn instructions refresh access for the actual app principal and reject other auth channels', async t => {
  const previousMode = process.env.CODEX_ACCESS_MODE;
  const previousPilot = process.env.CODEX_PILOT_USER_ID;
  t.after(() => {
    if (previousMode === undefined) delete process.env.CODEX_ACCESS_MODE;
    else process.env.CODEX_ACCESS_MODE = previousMode;
    if (previousPilot === undefined) delete process.env.CODEX_PILOT_USER_ID;
    else process.env.CODEX_PILOT_USER_ID = previousPilot;
  });
  const pilotUserId = randomUUID(), otherUserId = randomUUID();
  process.env.CODEX_PILOT_USER_ID = pilotUserId;
  const resolve = codexInstructions.events['turn.started'];
  assert.equal(typeof resolve, 'function');
  const instructionsFor = async current => {
    const definition = await resolve({ type: 'turn.started' }, { session: { auth: { current } } });
    return definition.content ?? definition.markdown;
  };
  const otherAppUser = { authenticator: 'app', principalId: otherUserId, attributes: {} };

  process.env.CODEX_ACCESS_MODE = 'pilot';
  assert.match(await instructionsFor(otherAppUser), /Otto is not enabled/);
  process.env.CODEX_ACCESS_MODE = 'shared';
  assert.match(await instructionsFor(otherAppUser), /Otto is enabled/);
  for (const current of [null, { authenticator: 'slack', principalId: otherUserId, attributes: {} }, { authenticator: 'app', principalId: '', attributes: {} }]) {
    assert.match(await instructionsFor(current), /Otto is not enabled/);
  }
  process.env.CODEX_ACCESS_MODE = 'disabled';
  assert.match(await instructionsFor(otherAppUser), /Otto is not enabled/);
  assert.match(await instructionsFor(otherAppUser), /Existing owned Otto jobs can still be inspected or cancelled/);
});
