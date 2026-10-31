/**
 * Pure judgement helpers for dock-squash-smoke.mjs's optional `--split` leg
 * (Stage 2, docs/development/dock.md). Extracted so the leg's verdict logic is
 * unit-testable headlessly (same discipline as workflow-map-smoke-assertions):
 * the smoke's failure output is its UI, and an aborted leg hid behind a bare
 * `split failed {ok:false,reason:split_refused}` with no branch for the
 * documented refusal case.
 *
 * The shapes below mirror the facade contract exactly:
 *  - `POST /dock/tabs/:id/split` → `{ok:true}` | `{ok:false, reason:"tab_not_present"|"split_refused"}` (renderer automation facade);
 *  - `GET /dock/state` → `{mode, width, conversationWidth, tabs:[{id,kind,title,active}], split}` (dockLayoutState).
 *
 * Split-click policy: a split_refused is retried (browser-tab click →
 * precondition wait → split click, bounded attempts). EVERY all-refused
 * outcome is a FAIL: with the preconditions held the store refused a split
 * that should have happened, and with the preconditions never held the leg
 * never exercised a split at all — the premise (focus the browser preview,
 * pin the git tab) is set up by the leg itself, so a premise that never
 * holds is a defect in the leg's own focus/click path, not a documented
 * expectation. Either way the smoke must not read ALL GREEN while neither a
 * split nor its auto-merge was ever observed.
 *
 * Zero npm deps; plain node >=22 ESM.
 */

/**
 * Classify a single 1800px split-click answer.
 *
 * - ok            → "pinned", the pin landed.
 * - split_refused → "refused", the store honestly reported a no-op click.
 * - anything else → "failed", a wiring defect (including tab_not_present or a
 *                   missing/unknown reason) the smoke must not swallow.
 */
export function classifySplitClick(clickBody) {
  if (clickBody?.ok === true) {
    return "pinned";
  }
  const reason = typeof clickBody?.reason === "string" ? clickBody.reason : "missing_reason";
  return reason === "split_refused" ? "refused" : "failed";
}

/**
 * Verdict for the bounded retry loop around the 1800px split click.
 * `attempts` is the ordered list of `{ preconditionsOk, click }` pairs — one
 * per browser-tab click → precondition wait → split click round.
 *
 * - any pinned click            → PASS, the split demonstrably happens.
 * - any failed click            → FAIL immediately (unknown/tab_not_present is
 *                                 a wiring defect, never expected).
 * - all clicks refused:
 *     · preconditions ever held → FAIL: preconditions held (pin target
 *                                 present, NOT the active primary, window
 *                                 wide) and the store still refused every
 *                                 attempt — splitting is broken.
 *     · preconditions never held→ FAIL: the split was never exercised. The
 *                                 premise is produced by the leg itself (it
 *                                 clicks the browser preview tab and waits
 *                                 for it to become the primary), so a premise
 *                                 that never held means that focus path is
 *                                 broken and the leg proved nothing.
 */
export function checkSplitRetryOutcome(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  const pinnedAttempt = list.find((a) => classifySplitClick(a?.click) === "pinned") ?? null;
  if (pinnedAttempt !== null) {
    const attemptNo = list.indexOf(pinnedAttempt) + 1;
    return {
      status: "PASS",
      label: "split right → split pinned",
      detail: `pinned on attempt ${attemptNo}/${list.length}${attemptNo > 1 ? " (after a transient refusal)" : ""}`,
    };
  }
  const failedAttempt = list.find((a) => classifySplitClick(a?.click) === "failed") ?? null;
  if (failedAttempt !== null) {
    return {
      status: "FAIL",
      label: "split right → split pinned",
      detail: `split failed: ${JSON.stringify(failedAttempt?.click)}`,
    };
  }
  const preconditionsEverHeld = list.some((a) => a?.preconditionsOk === true);
  if (list.length === 0) {
    return {
      status: "FAIL",
      label: "split right → split pinned",
      detail: "no split attempts recorded — the retry loop never ran",
    };
  }
  if (preconditionsEverHeld) {
    return {
      status: "FAIL",
      label: "split right → split pinned",
      detail: `split_refused on all ${list.length} attempt(s) while preconditions held (pin target present, not the active primary, window wide) — splitting is broken, not refused-for-cause`,
    };
  }
  return {
    status: "FAIL",
    label: "split right → split pinned",
    detail: `split_refused on all ${list.length} attempt(s) and the split preconditions never held — the focus/precondition path is broken, so the leg never exercised a split (not an expected refusal)`,
  };
}

/**
 * Which pinned state the leg should wait for after the 1800px click. Paired
 * with the click's classification: an ok click must pin; a refused click must
 * NOT (the store never left split:null), so the wait predicate is exact either
 * way — a refused-then-pinned or ok-then-stuck pair is a defect this catches.
 */
export function expectedSplitPredicate(clickBody) {
  return typeof clickBody?.ok === "boolean"
    ? (state) => (clickBody.ok ? typeof state.split === "string" : state.split === null)
    : () => false;
}

/**
 * Verdict for the pinned reading at 1800px (post-click state).
 */
export function checkPinned(clickBody, state) {
  if (clickBody?.ok === true) {
    const pinned = typeof state?.split === "string";
    return {
      status: pinned ? "PASS" : "FAIL",
      label: "1800px: split right → split pinned",
      detail: JSON.stringify(state?.split ?? null),
    };
  }
  const clean = state?.split === null || state?.split === undefined;
  return {
    status: clean ? "PASS" : "FAIL",
    label: "1800px: split refused → no stale pin (split:null)",
    detail: JSON.stringify(state?.split ?? null),
  };
}

/**
 * Verdict for the 900px auto-merge reading. Whatever the pin state was, a
 * window below `canSplit` must read split:null — but only a reading taken
 * AFTER a pin actually landed proves the merge. With `pinned: false` the
 * click never split anything, so a `split:null` state is the expected
 * absence of a split the leg never made, and reporting it as a passed
 * auto-merge would let a leg that never split read ALL GREEN.
 */
export function checkAutoMerged(state, pinned) {
  const merged = state?.split === null || state?.split === undefined;
  if (pinned !== true) {
    return {
      status: "FAIL",
      label: "900px: below canSplit → auto-merged",
      detail: `the split never pinned (split=${JSON.stringify(state?.split ?? null)}) — auto-merge was not exercised`,
    };
  }
  return {
    status: merged ? "PASS" : "FAIL",
    label: "900px: below canSplit → auto-merged",
    detail: JSON.stringify(state?.split ?? null),
  };
}

/**
 * Verdict for the deterministic-primary guard BEFORE the split click: the pin
 * target (git) must be present and NOT the active tab, and the active tab must
 * exist (a dock with no active tab cannot define "not the primary" either).
 * This is the leg's premise made explicit — the original step assumed the
 * browser preview was active and never checked.
 */
export function checkSplitPreconditions(state, pinTargetId) {
  const tabs = Array.isArray(state?.tabs) ? state.tabs : [];
  const target = tabs.find((t) => t.id === pinTargetId) ?? null;
  const active = tabs.find((t) => t.active) ?? null;
  if (target === null) {
    return { ok: false, detail: `pin target "${pinTargetId}" not present (tabs=${tabs.map((t) => t.id).join(",")})` };
  }
  if (active === null) {
    return { ok: false, detail: "no active tab — the split's \"not the primary\" premise is undefined" };
  }
  if (target.active) {
    return {
      ok: false,
      detail: `pin target "${pinTargetId}" IS the active primary (active=${active.id}) — isSplittableTab refuses; focus another tab first`,
    };
  }
  return { ok: true, detail: `active=${active.id}, pin target=${target.id}` };
}
