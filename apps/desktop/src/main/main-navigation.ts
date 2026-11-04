import type { WebContents } from "electron";

export function isRendererUrl(target: string, rendererUrl: string): boolean {
  try {
    const url = new URL(target);
    const renderer = new URL(rendererUrl);
    return url.protocol === renderer.protocol && url.host === renderer.host &&
      url.username === renderer.username && url.password === renderer.password && url.pathname === renderer.pathname;
  } catch {
    return false;
  }
}

export function isExternalUrl(target: string): boolean {
  try {
    const url = new URL(target);
    return ["https:", "http:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function protectMainNavigation(wc: WebContents, rendererUrl: string, openExternal: (url: string) => Promise<void>, loadDocument?: () => void): void {
  let recovery = 0;
  const open = (url: string): void => {
    if (isExternalUrl(url)) void openExternal(url).catch(() => {});
  };
  // Recovery must rebuild the document the window was created for, not just
  // its bare URL: the md popout's document lives in its query string
  // (?view=md-preview&tabId&previewId), so reloading the bare renderer URL
  // would bring the full app shell back inside the narrowed bridge — a
  // permanently non-functional window instead of a restored one. Callers
  // whose document IS the bare renderer URL (the main window) omit
  // loadDocument and keep the plain reload.
  const reload = (): void => {
    if (loadDocument !== undefined) {
      loadDocument();
      return;
    }
    void wc.loadURL(rendererUrl).catch(() => {});
  };
  wc.on("did-start-navigation", (event) => {
    if (event.isMainFrame && !event.isSameDocument && !isRendererUrl(event.url, rendererUrl)) {
      const attempt = ++recovery;
      setImmediate(() => {
        if (wc.isDestroyed() || recovery !== attempt) return;
        wc.stop();
        reload();
      });
    }
  });
  wc.on("did-navigate", (_event, url) => {
    if (!isRendererUrl(url, rendererUrl)) {
      ++recovery;
      reload();
    }
  });
  wc.on("will-navigate", (event) => {
    if (isRendererUrl(event.url, rendererUrl)) return;
    ++recovery;
    event.preventDefault();
    open(event.url);
  });
  wc.on("will-redirect", (event) => {
    if (event.isMainFrame && !isRendererUrl(event.url, rendererUrl)) {
      ++recovery;
      event.preventDefault();
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    open(url);
    return { action: "deny" };
  });
}
