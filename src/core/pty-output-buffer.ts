// Only fills up while a pane is hidden (see createRafPtyWriter's isSuspended
// check) — kept small since panes can stay hidden indefinitely and this is
// memory held per inactive pane.
const MAX_BUFFER_BYTES = 128 * 1024;

export class PtyOutputBuffer {
  private chunks: Uint8Array[] = [];
  private totalBytes = 0;

  push(data: Uint8Array): void {
    if (data.byteLength === 0) {
      return;
    }

    this.chunks.push(data);
    this.totalBytes += data.byteLength;

    while (this.totalBytes > MAX_BUFFER_BYTES && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (removed) {
        this.totalBytes -= removed.byteLength;
      }
    }
  }

  drain(): Uint8Array[] {
    const drained = this.chunks;
    this.chunks = [];
    this.totalBytes = 0;
    return drained;
  }

  get hasData(): boolean {
    return this.chunks.length > 0;
  }
}
