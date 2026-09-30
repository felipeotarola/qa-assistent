import { defineSandbox } from 'eve/sandbox';
export default defineSandbox(({ parent }) => {
  if (!parent) throw new Error('Repository specialist requires its coordinating parent.');
  return parent.sandbox;
});
