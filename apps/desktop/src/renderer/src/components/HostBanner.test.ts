import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HostBanner } from "./HostBanner.js";

function render(
  connection: "awaiting_port" | "awaiting_host_ready" | "ready" | "host_exited",
  lastFatal: string | null,
  workspaceMissing = false,
): string {
  return renderToStaticMarkup(createElement(HostBanner, { connection, lastFatal, workspaceMissing }));
}

describe("HostBanner — GitHub #6 missing workspace", () => {
  it("shows the missing folder and the way out instead of a connecting state", () => {
    const html = render(
      "host_exited",
      "Workspace folder does not exist: /missing/folder. Close this tab and choose another folder.",
      true,
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

  it("keeps the reconnecting state for an ORDINARY fatal — a failed turn does not stop a respawn", () => {
    // The regression this guards: suppressing every `lastFatal` left an old
    // fatal on screen through an exit+respawn, so the user could not tell that
    // the host was coming back.
    const html = render("host_exited", "Turn failed: upstream 500");
    expect(html).toContain("Host fatal: Turn failed: upstream 500");
    expect(html).toContain("Host process exited — reconnecting…");
  });

  it("an ordinary fatal over a live connection adds no connection line", () => {
    const html = render("ready", "Compaction failed");
    expect(html).toContain("Host fatal: Compaction failed");
    expect(html).not.toContain("reconnecting");
    expect(html).not.toContain("Connecting to host");
  });
});

it("shows a terminal host reason without promising reconnection", () => {
  const html = renderToStaticMarkup(createElement(HostBanner, { connection: "host_exited", lastFatal: null, workspaceMissing: false, hostFailure: { code: "per_tab_crash_loop", message: "Session host stopped after repeated crashes." } }));
  expect(html).toContain("Session host stopped after repeated crashes.");
  expect(html).not.toContain("reconnecting");
});
