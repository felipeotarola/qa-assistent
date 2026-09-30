// Browser pool: 3 GiB. System reserve: >=1 GiB. Code workers: 3 GiB total.
// Both repository jobs and interactive sandboxes take reservations here.
export class ResourceBudget {
  constructor(limitMiB = 3072) { this.limitMiB = limitMiB; this.reservations = new Map(); }
  get usedMiB() { return [...this.reservations.values()].reduce((sum, value) => sum + value, 0); }
  reserve(id, memoryMiB) {
    if (this.reservations.has(id)) return true;
    if (this.usedMiB + memoryMiB > this.limitMiB) return false;
    this.reservations.set(id, memoryMiB); return true;
  }
  release(id) { this.reservations.delete(id); }
  snapshot() { return { limitMiB: this.limitMiB, usedMiB: this.usedMiB, browserReservedMiB: 3072 }; }
}
