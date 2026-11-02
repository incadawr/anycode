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
  const open = (url: string): void => {
    if (isExternalUrl(url)) void openExternal(url).catch(() => {});
  };
  wc.on("will-navigate", (event) => {
    if (isRendererUrl(event.url, rendererUrl)) return;
    event.preventDefault();
    open(event.url);
  });
  wc.on("will-redirect", (event) => {
    if (event.isMainFrame && !isRendererUrl(event.url, rendererUrl)) event.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    open(url);
    return { action: "deny" };
  });
}
