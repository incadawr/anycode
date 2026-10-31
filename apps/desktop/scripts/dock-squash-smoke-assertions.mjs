/**
 * Pure judgement helpers for dock-squash-smoke.mjs's optional `--split` leg
 * (Stage 2, docs/development/dock.md). Extracted so the leg's verdict logic is
 * unit-testable headlessly (same discipline as workflow-map-smoke-assertions):
 * the smoke's failure output is its UI, and an aborted leg hid behind a bare
 * `split failed {ok:false,reason:split_refused}` with no branch for the
 * documented refusal case.
 *
 * The shapes below mirror the facade contract exactly:
 *  - `POST /dock/tabs/:id/split` → `{ok:true}` | `{ok:false, reason:"tab_not_present"|"split_refused"}` (renderer automation facade, cross-review D6);
 *  - `GET /dock/state` → `{mode, width, conversationWidth, tabs:[{id,kind,title,active}], split}` (dockLayoutState).
 *
 * Split-click policy (review 4839 follow-up): once the deterministic-primary
 * preconditions HELD, a split_refused is retried (browser-tab click →
 * precondition wait → split click, bounded attempts) and only a refusal that
 * persists through every attempt with preconditions held is a FAIL — an
 * always-refusing facade must never read ALL GREEN. A refusal is PASS-expected
 * only when a precondition genuinely failed (the premise never held).
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
 *     · preconditions never held→ PASS (expected): the premise itself never
 *                                 held, so the refusal is the documented
 *                                 honest answer, recorded as a counted row.
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
  if (preconditionsEverHeld || list.length === 0) {
    return {
      status: "FAIL",
      label: "split right → split pinned",
      detail: list.length === 0
        ? "no split attempts recorded — the retry loop never ran"
        : `split_refused on all ${list.length} attempt(s) while preconditions held (pin target present, not the active primary, window wide) — splitting is broken, not refused-for-cause`,
    };
  }
  return {
    status: "PASS",
    label: "split refused (expected: split preconditions never held)",
    detail: `facade answered {ok:false,reason:split_refused} on all ${list.length} attempt(s) and the precondition wait never held — the store refused the pin and reported it honestly`,
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
 * Verdict for the 900px auto-merge reading. Independent of how the click went:
 * whatever the pin state was, a window below `canSplit` must read split:null.
 */
export function checkAutoMerged(state) {
  const merged = state?.split === null || state?.split === undefined;
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
