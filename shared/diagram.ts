import { z } from 'zod';

const id = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
const webUrl = z.string().max(2000).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, 'Use an HTTP(S) URL without credentials');
export const diagramSchema = z.object({
  kind: z.literal('diagram'),
  summary: z.string().max(5000).default(''),
  direction: z.enum(['LR', 'TB']).default('LR'),
  nodes: z.array(z.object({ id, label: z.string().trim().min(1).max(160), category: z.string().max(80).default('Sida'), url: webUrl.default(''), description: z.string().max(2000).default('') })).max(150),
  edges: z.array(z.object({ id, source: id, target: id, label: z.string().max(160).default(''), status: z.enum(['verified', 'inferred']).default('inferred'), evidence: z.string().max(2000).default('') })).max(400),
  sources: z.array(z.object({ itemId: z.string().uuid(), version: z.number().int().positive() })).max(30).default([]),
}).superRefine((diagram, ctx) => {
  const nodes = new Set(diagram.nodes.map(node => node.id));
  if (nodes.size !== diagram.nodes.length) ctx.addIssue({ code: 'custom', message: 'Node IDs must be unique', path: ['nodes'] });
  if (new Set(diagram.edges.map(edge => edge.id)).size !== diagram.edges.length) ctx.addIssue({ code: 'custom', message: 'Edge IDs must be unique', path: ['edges'] });
  diagram.edges.forEach((edge, index) => {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) ctx.addIssue({ code: 'custom', message: 'Each relationship must reference existing nodes', path: ['edges', index] });
    if (edge.status === 'verified' && !edge.evidence.trim()) ctx.addIssue({ code: 'custom', message: 'Verified relationships need a source or observation', path: ['edges', index, 'evidence'] });
  });
});
export type DiagramContent = z.infer<typeof diagramSchema>;
