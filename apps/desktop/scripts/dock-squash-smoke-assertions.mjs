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
 * Zero npm deps; plain node >=22 ESM.
 */

/**
 * Verdict for the 1800px split click.
 *
 * - ok            → PASS, the pin landed.
 * - split_refused → the documented expected refusal (the tab was not
 *                   splittable at click time — e.g. it held the active
 *                   primary slot). Recorded as an explicit, counted PASS
 *                   row (`split refused (expected)`) so a red run can never
 *                   hide behind it; the auto-merge sub-leg still runs.
 * - anything else → FAIL (unknown reason string), including tab_not_present,
 *                   which is a wiring defect the smoke must not swallow.
 */
export function checkSplitClick(clickBody) {
  if (clickBody?.ok === true) {
    return { status: "PASS", label: "split right → split pinned", detail: "" };
  }
  const reason = typeof clickBody?.reason === "string" ? clickBody.reason : "missing_reason";
  if (reason === "split_refused") {
    return {
      status: "PASS",
      label: "split refused (expected: pin target not splittable at click time)",
      detail: "facade answered {ok:false,reason:split_refused} — the store refused the pin and reported it honestly",
    };
  }
  return { status: "FAIL", label: "split right → split pinned", detail: `split failed: ${JSON.stringify(clickBody)}` };
}

/**
 * Which pinned state the leg should wait for after the 1800px click. Paired
 * with checkSplitClick: an ok click must pin; a refused click must NOT (the
 * store never left split:null), so the wait predicate is exact either way —
 * a refused-then-pinned or ok-then-stuck pair is a defect this catches.
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
