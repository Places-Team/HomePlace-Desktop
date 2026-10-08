// Keep an item fetched from native code until the UI is ready to accept it.
export class DeferredInbox<T> {
  private pending: T | null = null;
  private running = false;
  private requested = false;

  async drain(read: () => Promise<T | null>, ready: () => boolean, accept: (item: T) => void) {
    this.requested = true;
    if (this.running) return;
    this.running = true;
    try {
      do {
        this.requested = false;
        while (ready()) {
          const item = this.pending ?? await read();
          if (item === null) break;
          this.pending = item;
          if (!ready()) break;
          accept(item);
          this.pending = null;
        }
      } while (this.requested && ready());
    } finally {
      this.running = false;
    }
  }
}
