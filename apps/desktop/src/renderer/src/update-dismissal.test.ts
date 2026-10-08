import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../shared/updates.js";
import {
  UPDATE_DISMISSED_KEY,
  dismissUpdateBanner,
  isUpdateBannerDismissed,
  readDismissedUpdateBanner,
  updateBannerKey,
} from "./update-dismissal.js";

afterEach(() => vi.unstubAllGlobals());

/** Stubs `window.localStorage` with an in-memory map; returns it for direct assertions. */
function stubStorage(seed?: Record<string, string>): Map<string, string> {
  const values = new Map<string, string>(Object.entries(seed ?? {}));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  return values;
}

describe("updateBannerKey", () => {
  it("is null for every state that raises no banner", () => {
    const silent: UpdateStatus[] = [
      { kind: "idle" },
      { kind: "checking" },
      { kind: "downloading", percent: 40 },
      { kind: "not-available" },
      { kind: "error", message: "feed unreachable" },
    ];
    for (const status of silent) {
      expect(updateBannerKey(status)).toBeNull();
    }
  });

  it("separates releases, so dismissing one version never hides the next", () => {
    expect(updateBannerKey({ kind: "available", version: "0.0.27" })).not.toBe(
      updateBannerKey({ kind: "available", version: "0.0.28" }),
    );
  });

  it("separates lifecycle states, so 'restart to install' is not swallowed by an earlier dismissal", () => {
    expect(updateBannerKey({ kind: "available", version: "0.0.27" })).not.toBe(
      updateBannerKey({ kind: "downloaded", version: "0.0.27" }),
    );
  });

  it("ignores manualOnly: the darwin wording differs, the release it announces does not", () => {
    expect(updateBannerKey({ kind: "available", version: "0.0.27", manualOnly: true })).toBe(
      updateBannerKey({ kind: "available", version: "0.0.27" }),
    );
  });
});

describe("isUpdateBannerDismissed", () => {
  const dismissed = "available:0.0.27";

  it("hides exactly the message that was closed", () => {
    expect(isUpdateBannerDismissed({ kind: "available", version: "0.0.27" }, dismissed)).toBe(true);
    expect(isUpdateBannerDismissed({ kind: "available", version: "0.0.28" }, dismissed)).toBe(false);
    expect(isUpdateBannerDismissed({ kind: "downloaded", version: "0.0.27" }, dismissed)).toBe(false);
  });

  it("nothing is dismissed when nothing was stored", () => {
    expect(isUpdateBannerDismissed({ kind: "available", version: "0.0.27" }, null)).toBe(false);
  });
});

describe("dismissal storage", () => {
  it("round-trips the closed banner's key under one namespaced entry", () => {
    const values = stubStorage();

    expect(dismissUpdateBanner({ kind: "available", version: "0.0.27", manualOnly: true })).toBe("available:0.0.27");

    expect(values.get(UPDATE_DISMISSED_KEY)).toBe("available:0.0.27");
    expect(readDismissedUpdateBanner()).toBe("available:0.0.27");
  });

  it("a status with no banner writes nothing", () => {
    const values = stubStorage();

    expect(dismissUpdateBanner({ kind: "downloading", percent: 10 })).toBeNull();

    expect(values.has(UPDATE_DISMISSED_KEY)).toBe(false);
  });

  it("an empty stored value reads as 'nothing dismissed'", () => {
    stubStorage({ [UPDATE_DISMISSED_KEY]: "" });

    expect(readDismissedUpdateBanner()).toBeNull();
  });

  it("unreadable storage fails OPEN — an update notice is never hidden by a broken preference", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("storage denied");
      },
    });

    expect(readDismissedUpdateBanner()).toBeNull();
  });

  it("unwritable storage still closes the banner for this session", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota exceeded");
        },
      },
    });

    expect(dismissUpdateBanner({ kind: "downloaded", version: "0.0.27" })).toBe("downloaded:0.0.27");
  });
});
