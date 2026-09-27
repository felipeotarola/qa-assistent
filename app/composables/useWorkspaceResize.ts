const DEFAULT_WIDTH = 46;
const MIN_WIDTH = 30;
const MAX_WIDTH = 70;

export function useWorkspaceResize() {
  const savedWidth = useCookie<number>("pat_chat_width", {
    default: () => DEFAULT_WIDTH,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
  const clamp = (value: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));
  const width = ref(clamp(typeof savedWidth.value === "number" && Number.isFinite(savedWidth.value) ? savedWidth.value : DEFAULT_WIDTH));
  const container = ref<HTMLElement>();
  const dragging = ref(false);
  let frame = 0;
  let pointerX = 0;
  let bounds: DOMRect | undefined;
  let handle: HTMLElement | undefined;
  let pointerId: number | undefined;
  let originalCursor = "";
  let originalSelection = "";

  function applyPosition() {
    frame = 0;
    if (bounds?.width) width.value = clamp((pointerX - bounds.left) / bounds.width * 100);
  }

  function finish() {
    if (!dragging.value) return;
    if (frame) {
      cancelAnimationFrame(frame);
      applyPosition();
    }
    dragging.value = false;
    savedWidth.value = width.value;
    document.documentElement.style.cursor = originalCursor;
    document.documentElement.style.userSelect = originalSelection;
    window.removeEventListener("blur", finish);
    if (pointerId !== undefined && handle?.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    handle = undefined;
    pointerId = undefined;
  }

  function start(event: PointerEvent) {
    if (event.button !== 0 || !container.value || dragging.value) return;
    event.preventDefault();
    bounds = container.value.getBoundingClientRect();
    handle = event.currentTarget as HTMLElement;
    pointerId = event.pointerId;
    pointerX = event.clientX;
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(pointerId);
    originalCursor = document.documentElement.style.cursor;
    originalSelection = document.documentElement.style.userSelect;
    document.documentElement.style.cursor = "col-resize";
    document.documentElement.style.userSelect = "none";
    dragging.value = true;
    window.addEventListener("blur", finish);
  }

  function move(event: PointerEvent) {
    if (!dragging.value || event.pointerId !== pointerId) return;
    pointerX = event.clientX;
    if (!frame) frame = requestAnimationFrame(applyPosition);
  }

  function reset() {
    width.value = DEFAULT_WIDTH;
    savedWidth.value = DEFAULT_WIDTH;
  }

  function keydown(event: KeyboardEvent) {
    const step = event.shiftKey ? 5 : 2;
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Enter") return reset();
    width.value = event.key === "Home" ? MIN_WIDTH
      : event.key === "End" ? MAX_WIDTH
        : clamp(width.value + (event.key === "ArrowRight" ? step : -step));
    savedWidth.value = width.value;
  }

  onBeforeUnmount(finish);
  return { container, width, dragging, start, move, finish, reset, keydown, min: MIN_WIDTH, max: MAX_WIDTH };
}
