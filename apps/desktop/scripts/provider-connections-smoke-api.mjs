/** All provider smoke requests, including teardown, require the verified channel. */
export async function providerSmokeApi(ctx, method, path, body) {
  if (!ctx.cdp || !ctx.port || !ctx.token) throw new Error("Verified automation channel is unavailable");
  const response = await ctx.cdp.automation({port:ctx.port, token:ctx.token}, path, method, body);
  return {status:response.status, body:response.result};
}

/** Never signal a process group again after its launcher has exited. */
export async function stopProviderSmokeLauncher(child, { kill, sleep, graceMs }) {
  const running = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  if (!running()) return;
  kill(child.pid, "SIGTERM");
  await sleep(graceMs);
  if (running()) kill(child.pid, "SIGKILL");
}

/** Publish the child before any asynchronous startup work can be interrupted. */
export function registerProviderSmokeChild(ctx, child, register) {
  ctx.child = child;
  register(ctx);
}

/** Signal and normal paths must await the same teardown. */
export function providerSmokeTeardown(ctx, workspaces, teardownApp) {
  if (!ctx.teardownPromise) ctx.teardownPromise = teardownApp(ctx, workspaces);
  return ctx.teardownPromise;
}
