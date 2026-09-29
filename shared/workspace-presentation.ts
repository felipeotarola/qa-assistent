import type { ItemContent } from './workspace';

export const materialKinds: Record<ItemContent['kind'], { label: string; icon: string }> = {
  text: { label: 'Dokument', icon: 'i-lucide-file-text' },
  table: { label: 'Tabell', icon: 'i-lucide-table-2' },
  diagram: { label: 'Diagram', icon: 'i-lucide-workflow' },
  image: { label: 'Bild', icon: 'i-lucide-image' },
  file: { label: 'Fil', icon: 'i-lucide-file' },
  test_plan: { label: 'Testplan', icon: 'i-lucide-list-checks' },
};
