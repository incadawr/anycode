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

export function protectMainNavigation(wc: WebContents, rendererUrl: string, openExternal: (url: string) => Promise<void>): void {
  let recovery = 0;
  const open = (url: string): void => {
    if (isExternalUrl(url)) void openExternal(url).catch(() => {});
  };
  wc.on("did-start-navigation", (event) => {
    if (event.isMainFrame && !event.isSameDocument && !isRendererUrl(event.url, rendererUrl)) {
      const attempt = ++recovery;
      setImmediate(() => {
        if (wc.isDestroyed() || recovery !== attempt) return;
        wc.stop();
        void wc.loadURL(rendererUrl).catch(() => {});
      });
    }
  });
  wc.on("did-navigate", (_event, url) => {
    if (!isRendererUrl(url, rendererUrl)) {
      ++recovery;
      void wc.loadURL(rendererUrl).catch(() => {});
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
