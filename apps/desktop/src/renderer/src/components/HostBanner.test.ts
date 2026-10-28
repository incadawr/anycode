import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HostBanner } from "./HostBanner.js";

function render(connection: "awaiting_port" | "awaiting_host_ready" | "ready" | "host_exited", lastFatal: string | null): string {
  return renderToStaticMarkup(createElement(HostBanner, { connection, lastFatal }));
}

describe("HostBanner — GitHub #6 missing workspace", () => {
  it("shows the missing folder and the way out instead of a connecting state", () => {
    const html = render(
      "host_exited",
      "Workspace folder does not exist: /missing/folder. Close this tab and choose another folder.",
    );
    expect(html).toContain("Workspace folder does not exist: /missing/folder");
    expect(html).toContain("Close this tab and choose another folder");
    expect(html).not.toContain("Connecting to host");
    // The regression: an unrecoverable start must not claim it is reconnecting.
    expect(html).not.toContain("reconnecting");
  });

  it("still renders the plain connecting / exited lines when there is no fatal", () => {
    expect(render("awaiting_host_ready", null)).toContain("Connecting to host");
    expect(render("host_exited", null)).toContain("Host process exited — reconnecting…");
    expect(render("ready", null)).toBe("");
  });
});
