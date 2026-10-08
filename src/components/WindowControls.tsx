import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

function ignoreWindowError(promise: Promise<unknown>) {
  void promise.catch(() => undefined);
}

export function WindowControls({ language = "en" }: { language?: "ru" | "en" }) {
  const [maximized, setMaximized] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const maximizeButton = useRef<HTMLButtonElement>(null);
  const menuWrapper = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const ru = language === "ru";
  const [appWindow] = useState(() => {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (!appWindow) return;
    const nativeWindow = appWindow;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    async function updateMaximized() {
      try {
        const value = await nativeWindow.isMaximized();
        if (disposed) return;
        setMaximized(value);
        document.documentElement.dataset.maximized = String(value);
      } catch {
        // The browser-only Vite preview has no native window to inspect.
      }
    }

    void updateMaximized();
    void nativeWindow.onResized(() => void updateMaximized()).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appWindow]);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = () => {
      clearTimeout(hoverTimer.current);
      setMenuOpen(false);
    };
    const outsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuWrapper.current?.contains(event.target)) dismiss();
    };
    window.addEventListener("pointerdown", outsidePointer);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", outsidePointer);
      window.removeEventListener("blur", dismiss);
    };
  }, [menuOpen]);

  function closeMenu(restoreFocus = false) {
    clearTimeout(hoverTimer.current);
    setMenuOpen(false);
    if (restoreFocus) maximizeButton.current?.focus();
  }

  function handleMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    items[next]?.focus();
  }

  function toggleMaximize() {
    closeMenu();
    if (!appWindow) return;
    ignoreWindowError(
      appWindow.toggleMaximize().then(async () => {
        const value = await appWindow.isMaximized();
        setMaximized(value);
        document.documentElement.dataset.maximized = String(value);
      }),
    );
  }

  function snap(layout: string) {
    closeMenu(true);
    void invoke("snap_window", { layout }).then(() => {
      setMaximized(layout === "maximize");
      document.documentElement.dataset.maximized = String(layout === "maximize");
    }).catch(() => undefined);
  }

  const snapLayouts = [
    ["left", ru ? "Слева" : "Snap left"],
    ["right", ru ? "Справа" : "Snap right"],
    ["top-left", ru ? "Сверху слева" : "Snap top left"],
    ["top-right", ru ? "Сверху справа" : "Snap top right"],
    ["bottom-left", ru ? "Снизу слева" : "Snap bottom left"],
    ["bottom-right", ru ? "Снизу справа" : "Snap bottom right"],
  ] as const;

  return (
    <div className="window-controls" aria-label={ru ? "Управление окном" : "Window controls"}>
      <button
        className="window-control"
        type="button"
        aria-label={ru ? "Свернуть окно" : "Minimize window"}
        title={ru ? "Свернуть" : "Minimize"}
        onClick={() => appWindow && ignoreWindowError(appWindow.minimize())}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 8.5h8" /></svg>
      </button>
      <div ref={menuWrapper} className="window-control-wrap"
        onPointerEnter={() => {
          clearTimeout(hoverTimer.current);
          hoverTimer.current = setTimeout(() => setMenuOpen(true), 420);
        }}
        onPointerLeave={() => {
          clearTimeout(hoverTimer.current);
          if (!menu.current?.contains(document.activeElement)) setMenuOpen(false);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) closeMenu();
        }}
        onKeyDown={handleMenuKey}
      >
        <button
          ref={maximizeButton}
          className="window-control"
          type="button"
          aria-label={maximized ? (ru ? "Восстановить окно" : "Restore window") : (ru ? "Развернуть окно" : "Maximize window")}
          title={ru ? "Развернуть / восстановить; ↓ — раскладка" : "Maximize / restore; ↓ for layouts"}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls="window-snap-menu"
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown") return;
            event.preventDefault();
            event.stopPropagation();
            clearTimeout(hoverTimer.current);
            setMenuOpen(true);
            requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>("button")?.focus());
          }}
          onClick={toggleMaximize}
        >
          {maximized ? (
            <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 4.5h5v5h-5zM5 4.5V3h4v4H8.5" /></svg>
          ) : (
            <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5h7v7h-7z" /></svg>
          )}
        </button>
        {menuOpen && <div ref={menu} id="window-snap-menu" className="snap-layouts" role="menu" aria-label={ru ? "Раскладка окон" : "Snap layouts"}>
          {snapLayouts.map(([layout, label]) => (
            <button key={layout} type="button" role="menuitem" aria-label={label} title={label} onClick={() => snap(layout)}>
              <span className={`snap-preview ${layout}`} aria-hidden><i /><i /><i /><i /></span>
            </button>
          ))}
          <button type="button" role="menuitem" aria-label={ru ? "Развернуть" : "Maximize"} title={ru ? "Развернуть" : "Maximize"} onClick={() => snap("maximize")}>
            <span className="snap-preview maximize" aria-hidden><i /><i /><i /><i /></span>
          </button>
        </div>}
      </div>
      <button
        className="window-control window-close"
        type="button"
        aria-label={ru ? "Закрыть окно" : "Close window"}
        title={ru ? "Закрыть" : "Close"}
        onClick={() => appWindow && ignoreWindowError(appWindow.close())}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 2.5 7 7m0-7-7 7" /></svg>
      </button>
    </div>
  );
}
