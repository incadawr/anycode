/** Read only the message body, excluding speaker labels and timestamps. */
export function userMessageTexts(document) {
  return [...document.querySelectorAll('.message-user')].map((el) => el.querySelector('.message-text')?.textContent ?? '');
}

export function noSlashBubble(state) {
  return state.userMessages.every((text) => text.trim() !== "/compact" && !text.trim().startsWith("/compact "));
}

/** Approval must precede an observable tool start while the turn is still busy. */
export async function waitForApprovedTool({ readState, approve, markerExists, sleep, now, timeoutMs }) {
  const deadline = now() + timeoutMs;
  let approved = false;
  while (now() < deadline) {
    const state = await readState();
    if (!approved && state.permissionOpen) {
      if (state.permissionTool !== 'Bash' || !state.permissionInput.includes('compact-smoke-started') || !state.permissionInput.includes('sleep 25')) {
        throw new Error('unexpected tool approval: ' + JSON.stringify(state));
      }
      if (!(await approve()).ok) throw new Error('could not grant Bash approval');
      approved = true;
    }
    if (approved && state.running && markerExists()) return state;
    await sleep(200);
  }
  throw new Error(approved ? 'approved tool did not visibly start while running' : 'Bash approval did not appear');
}
