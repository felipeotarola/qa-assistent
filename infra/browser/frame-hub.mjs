// One capture per session, shared by all viewers. Hidden viewers retain the
// connection but do not cause capture work or receive a stream of unused frames.
export class FrameHub {
  constructor(capture, send, interval = 250) {
    this.capture = capture; this.send = send; this.interval = interval;
    this.viewers = new Map(); this.running = false; this.closed = false;
  }
  add(viewer) { this.viewers.set(viewer, true); this.start(); }
  remove(viewer) { this.viewers.delete(viewer); }
  visibility(viewer, visible) { if (this.viewers.has(viewer)) this.viewers.set(viewer, visible); if (visible) this.start(); }
  start() { if (!this.running && !this.closed) { this.running = true; void this.frame(); } }
  async frame() {
    try {
      if (!this.closed && [...this.viewers.values()].some(Boolean)) {
        const image = await this.capture();
        if (!this.closed) for (const [viewer, visible] of this.viewers) if (visible) this.send(viewer, image);
      }
    } catch { /* Navigation can briefly prevent screenshots. */ }
    if (!this.closed && [...this.viewers.values()].some(Boolean)) this.timer = setTimeout(() => { void this.frame(); }, this.interval);
    else this.running = false;
  }
  close() { this.closed = true; clearTimeout(this.timer); this.viewers.clear(); }
}
