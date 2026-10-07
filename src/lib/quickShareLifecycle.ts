export const QUICK_SHARE_EXIT_MS = 120;

/** Cancel pending dismissal whenever the shelf receives a new interaction. */
export class QuickShareLifecycle {
  private exitTimer: ReturnType<typeof setTimeout> | undefined;
  private successTimer: ReturnType<typeof setTimeout> | undefined;
  private dragEndTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly visibility: (visible: boolean) => void,
    private readonly hide: (discard: boolean) => void,
    private readonly nativeVisibility: (visible: boolean) => void = () => {},
  ) {}

  open() {
    this.dispose();
    this.visibility(true);
    this.nativeVisibility(true);
  }

  close(discard = false) {
    this.dispose();
    this.visibility(false);
    this.nativeVisibility(false);
    this.exitTimer = setTimeout(() => {
      this.exitTimer = undefined;
      this.hide(discard);
    }, QUICK_SHARE_EXIT_MS);
  }

  afterSuccess(dismiss: () => void) {
    this.dispose();
    this.successTimer = setTimeout(dismiss, 1600);
  }

  endDrag(canClose: () => boolean) {
    clearTimeout(this.dragEndTimer);
    // Let native/WebView drop events stage content before deciding to dismiss.
    this.dragEndTimer = setTimeout(() => {
      this.dragEndTimer = undefined;
      if (canClose()) this.close(false);
    }, 450);
  }

  dispose() {
    clearTimeout(this.exitTimer);
    clearTimeout(this.successTimer);
    clearTimeout(this.dragEndTimer);
    this.exitTimer = undefined;
    this.successTimer = undefined;
    this.dragEndTimer = undefined;
  }
}
