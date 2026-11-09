import { describe, expect, it } from "vitest";
import type { NativeProjectView } from "../../../shared/session-peer-view.js";
import {
  commonReasonLine,
  commonRowReason,
  countGranted,
  filterPeers,
  grantedSummary,
  grantBlockedReason,
  inactiveGrantNote,
  inactiveGrants,
  peersDialogText,
  revokeBlockedReason,
  rowBlockedReason,
  rowReason,
  shortenPath,
  sortPeers,
} from "./session-peers-dialog-model.js";

function peer(key: string, over: Partial<NativeProjectView> = {}): NativeProjectView {
  const name = key.split("/").filter(Boolean).pop() ?? key;
  return { key, name, enabled: true, trusted: true, granted: false, ...over };
}

describe("sortPeers", () => {
  it("puts the granted peers first, then orders by name and breaks a tie by key", () => {
    const peers = [
      peer("/w/beta", { granted: true }),
      peer("/w/app"),
      peer("/w/alpha"),
      peer("/w/app-2", { name: "app" }),
    ];
    expect(sortPeers(peers).map(entry => entry.key)).toEqual(["/w/beta", "/w/alpha", "/w/app", "/w/app-2"]);
  });

  it("keeps two folders with the same name apart and never mutates the given list", () => {
    const peers = [peer("/one/app", { name: "app" }), peer("/two/app", { name: "app" })];
    const sorted = sortPeers(peers);
    expect(sorted.map(entry => entry.key)).toEqual(["/one/app", "/two/app"]);
    expect(peers.map(entry => entry.key)).toEqual(["/one/app", "/two/app"]);
  });
});

describe("filterPeers", () => {
  const peers = [peer("/w/alpha"), peer("/w/beta"), peer("/w/gamma", { name: "Gamma" })];

  it("matches the name case-insensitively", () => {
    expect(filterPeers(peers, "GAMMA").map(entry => entry.key)).toEqual(["/w/gamma"]);
  });

  it("matches the full key (the path) case-insensitively", () => {
    expect(filterPeers(peers, "/W/BET").map(entry => entry.key)).toEqual(["/w/beta"]);
  });

  it("keeps every peer for an empty query and returns nothing when nothing matches", () => {
    expect(filterPeers(peers, "   ")).toHaveLength(3);
    expect(filterPeers(peers, "nothing-here")).toEqual([]);
  });
});

describe("the grant state", () => {
  it("counts the configured grants even when a peer is off or untrusted", () => {
    const peers = [
      peer("/w/alpha", { granted: true }),
      peer("/w/beta", { granted: true, enabled: false }),
      peer("/w/gamma", { granted: true, trusted: false }),
      peer("/w/delta"),
    ];
    expect(countGranted(peers)).toBe(3);
  });

  it("explains the count as a configuration, not as live reachability", () => {
    expect(grantedSummary([peer("/w/alpha", { granted: true }), peer("/w/beta")]))
      .toBe("Communication is configured with 1 of the 2 peer projects.");
    expect(grantedSummary([peer("/w/alpha")]))
      .toBe("Communication is not configured with the peer project.");
  });
});

describe("grantBlockedReason", () => {
  const project = peer("/w/current");

  it("keeps the fixed precedence: busy, current untrusted, current off, peer untrusted, peer off", () => {
    const other = peer("/w/other");
    expect(grantBlockedReason(project, other, true)).toBe("busy");
    expect(grantBlockedReason({ ...project, trusted: false }, { ...other, trusted: false, enabled: false }, true)).toBe("busy");
    expect(grantBlockedReason({ ...project, trusted: false }, { ...other, enabled: false })).toBe("current_untrusted");
    expect(grantBlockedReason({ ...project, enabled: false }, { ...other, trusted: false })).toBe("current_off");
    expect(grantBlockedReason(project, { ...other, trusted: false })).toBe("peer_untrusted");
    expect(grantBlockedReason(project, { ...other, enabled: false })).toBe("peer_off");
    expect(grantBlockedReason(project, other)).toBeUndefined();
  });

  it("names a reason for every blocked state", () => {
    expect(peersDialogText.reason.busy).toBeTruthy();
    expect(peersDialogText.reason.current_untrusted).toBeTruthy();
    expect(peersDialogText.reason.current_off).toBeTruthy();
    expect(peersDialogText.reason.peer_untrusted).toBeTruthy();
    expect(peersDialogText.reason.peer_off).toBeTruthy();
  });
});

describe("revoking", () => {
  it("stays possible when one of the projects is off or untrusted", () => {
    const project = { ...peer("/w/current"), enabled: false, trusted: false };
    const other = { ...peer("/w/other", { granted: true }), enabled: false, trusted: false };
    expect(revokeBlockedReason(false)).toBeUndefined();
    expect(rowBlockedReason(project, other, false)).toBeUndefined();
    expect(rowBlockedReason(project, other, true)).toBe("busy");
  });

  it("shows the inactive reason of a saved grant without locking the row", () => {
    const project = { ...peer("/w/current"), enabled: false };
    const other = { ...peer("/w/other", { granted: true }), enabled: false };
    expect(rowReason(project, other)).toBe("current_off");
    expect(rowReason(project, other, true)).toBe("busy");
  });
});

describe("inactiveGrants", () => {
  it("lists the saved grants that cannot be used right now and explains them", () => {
    const project = peer("/w/current");
    const peers = [
      peer("/w/alpha", { granted: true }),
      peer("/w/beta", { granted: true, enabled: false }),
      peer("/w/gamma"),
    ];
    expect(inactiveGrants(project, peers).map(entry => entry.peer.key)).toEqual(["/w/beta"]);
    expect(inactiveGrantNote(project, peers)).toContain("1 of the configured grants is currently inactive");
    expect(inactiveGrantNote(project, peers)).toContain(peersDialogText.reason.peer_off);
  });

  it("says nothing when every configured grant is usable", () => {
    const project = peer("/w/current");
    const peers = [peer("/w/alpha", { granted: true })];
    expect(inactiveGrantNote(project, peers)).toBeUndefined();
  });
});

describe("shortenPath", () => {
  it("keeps the tail of a long path and never abbreviates the home directory", () => {
    expect(shortenPath("/Users/ann/code/app")).toBe("…/code/app");
    expect(shortenPath("/Users/ann/code/app")).not.toContain("~");
  });

  it("leaves a short path as it is", () => {
    expect(shortenPath("/w/app")).toBe("/w/app");
    expect(shortenPath("")).toBe("");
  });
});

describe("commonRowReason", () => {
  const project = { key: "/w/current", name: "current", enabled: true, trusted: true, granted: false };

  it("returns the reason once when every not-yet-granted row shares it", () => {
    const rows = [peer("/w/a", { enabled: false }), peer("/w/b", { enabled: false }), peer("/w/c", { granted: true, enabled: false })];
    expect(commonRowReason(project, rows)).toEqual({ reason: "peer_off", count: 2 });
    expect(commonRowReason({ ...project, enabled: false }, [peer("/w/a"), peer("/w/b")])).toEqual({ reason: "current_off", count: 2 });
  });

  it("keeps per-row reasons when they differ, when one row has none, or when only one row is open", () => {
    expect(commonRowReason(project, [peer("/w/a", { enabled: false }), peer("/w/b", { trusted: false })])).toBeUndefined();
    expect(commonRowReason(project, [peer("/w/a", { enabled: false }), peer("/w/b")])).toBeUndefined();
    expect(commonRowReason(project, [peer("/w/a", { enabled: false })])).toBeUndefined();
    expect(commonRowReason(project, [])).toBeUndefined();
  });

  it("words the line above the list", () => {
    expect(commonReasonLine("peer_off", 46)).toBe("46 projects cannot be enabled: Native access is off for that folder");
    expect(commonReasonLine("busy", 3)).toBe("Saving…");
  });
});
