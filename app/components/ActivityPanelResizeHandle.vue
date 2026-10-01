<script setup lang="ts">
const width = defineModel<number>({ required: true });
const props = defineProps<{ collapsed?: boolean }>();
const emit = defineEmits<{ collapse: []; expand: []; preview: [width: number | null] }>();
const minimum = 280, maximum = 520;
const railWidth = 56;
const dragging = ref(false);
const dragWidth = ref<number | null>(null);
let startX = 0, startWidth = 0;
let handle: HTMLElement | undefined;
let pointerId: number | undefined;
let oldCursor = '', oldSelection = '';
const clamp = (value: number) => Math.round(Math.max(minimum, Math.min(maximum, window.innerWidth - 24, value)));
function finish() {
  if (!dragging.value) return;
  dragging.value = false;
  document.documentElement.style.cursor = oldCursor;
  document.documentElement.style.userSelect = oldSelection;
  window.removeEventListener('blur', finish);
  if (pointerId !== undefined && handle?.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  handle = undefined; pointerId = undefined;
  dragWidth.value = null;
  emit('preview', null);
}
function release() {
  if (!dragging.value) return;
  const finalWidth = dragWidth.value ?? startWidth;
  if (finalWidth >= minimum) width.value = clamp(finalWidth);
  finish();
  if (finalWidth < minimum) emit('collapse');
  else emit('expand');
}
function start(event: PointerEvent) {
  if (event.button !== 0 || dragging.value) return;
  event.preventDefault();
  startX = event.clientX; startWidth = props.collapsed ? railWidth : width.value;
  handle = event.currentTarget as HTMLElement; pointerId = event.pointerId;
  handle.focus({ preventScroll: true }); handle.setPointerCapture(pointerId);
  oldCursor = document.documentElement.style.cursor; oldSelection = document.documentElement.style.userSelect;
  document.documentElement.style.cursor = 'col-resize'; document.documentElement.style.userSelect = 'none';
  dragging.value = true;
  dragWidth.value = startWidth;
  emit('preview', startWidth);
  window.addEventListener('blur', finish);
}
function move(event: PointerEvent) {
  if (!dragging.value || event.pointerId !== pointerId) return;
  const nextWidth = startWidth + startX - event.clientX;
  dragWidth.value = Math.round(Math.max(railWidth, Math.min(maximum, window.innerWidth - 24, nextWidth)));
  emit('preview', dragWidth.value);
  if (nextWidth <= railWidth && !props.collapsed) {
    finish();
    emit('collapse');
  }
}
function keydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
  event.preventDefault();
  if (props.collapsed) {
    if (['ArrowLeft', 'Enter', 'End'].includes(event.key)) emit('expand');
    return;
  }
  if (event.key === 'ArrowRight' && width.value <= minimum) { emit('collapse'); return; }
  const step = event.shiftKey ? 40 : 16;
  width.value = event.key === 'Home' ? minimum : event.key === 'End' ? maximum : event.key === 'Enter' ? 360
    : clamp(width.value + (event.key === 'ArrowLeft' ? step : -step));
}
onBeforeUnmount(finish);
function reset() { width.value = 360; emit('expand'); }
</script>

<template>
  <div role="separator" tabindex="0" :aria-label="collapsed ? 'Dra för att öppna Pågående arbete' : 'Ändra bredd på Pågående arbete'" aria-orientation="vertical" :aria-valuemin="railWidth" :aria-valuemax="maximum" :aria-valuenow="dragWidth ?? (collapsed ? railWidth : width)" :aria-valuetext="`${dragWidth ?? (collapsed ? railWidth : width)} pixlar`" :title="collapsed ? 'Dra åt vänster för att öppna' : 'Dra till högerkanten för att fälla ihop · Dubbelklicka för att återställa'" class="activity-resize-handle absolute inset-y-0 -left-1.5 z-30 w-3 cursor-col-resize touch-none outline-none" :class="{ 'is-dragging': dragging }" @pointerdown="start" @pointermove="move" @pointerup="release" @pointercancel="finish" @lostpointercapture="finish" @keydown="keydown" @dblclick="reset">
    <span class="absolute left-1/2 top-1/2 h-9 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accented" />
  </div>
</template>

<style scoped>
.activity-resize-handle:hover span, .activity-resize-handle:focus-visible span, .activity-resize-handle.is-dragging span { background: var(--ui-text-muted); }
.activity-resize-handle::before { content: ''; position: absolute; inset: 0 5px; background: var(--ui-text-muted); opacity: 0; }
.activity-resize-handle:hover::before, .activity-resize-handle:focus-visible::before, .activity-resize-handle.is-dragging::before { opacity: 0.45; }
</style>
