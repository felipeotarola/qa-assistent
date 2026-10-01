import type { WorkspaceItem } from "#shared/workspace";
import type { InjectionKey, ShallowRef } from "vue";
interface CardAgent {
  workspaceId: string;
  available: boolean;
  ask: (text: string) => Promise<boolean>;
  run: (item: WorkspaceItem, text: string) => Promise<boolean>;
}
const key: InjectionKey<ShallowRef<CardAgent | null>> = Symbol("workspace-agent");
export function provideWorkspaceAgent() { provide(key, shallowRef<CardAgent | null>(null)); }
export function useWorkspaceAgent() { return inject(key, shallowRef<CardAgent | null>(null)); }
