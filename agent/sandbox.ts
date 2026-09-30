import { defineSandbox } from 'eve/sandbox';
import { vpsSandbox } from './lib/vps-sandbox';

export default defineSandbox({
  backend: vpsSandbox,
  async onSession({ use, ctx }) {
    const auth = ctx.session.auth.current;
    const threadId = auth?.attributes.browserThreadId;
    if (auth?.authenticator !== 'app' || !auth.principalId || typeof threadId !== 'string') throw new Error('VPS sandbox requires an authenticated workspace chat.');
    await use({ userId: auth.principalId, threadId });
  },
});
