/**
 * UI-kit gallery smoke: opens the DEV gallery (?view=ui-gallery) and captures
 * one frame per theme so the W1 families are reviewed in both themes.
 *
 * Usage: node apps/desktop/scripts/ui-gallery-smoke.mjs --out <dir>
 * Exit code 0 → PASS, 2 → PASS_WITH_UNVERIFIED, 1 → FAIL.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildSmokeEnv } from './model-overrides-smoke-env.mjs';
import { launchSmokeElectron } from './smoke-electron-launch.mjs';
import { connectIsolatedCdp } from './isolated-cdp.mjs';

const profile = mkdtempSync(join(tmpdir(), 'anycode-gallery-'));
const binary = join(profile, 'unavailable-engine');
writeFileSync(binary, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const env = buildSmokeEnv(process.env, profile, 0, binary);
writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  version: 2, provider: { activeConnectionId: 'conn-smoke', custom: [], connections: [] },
  tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: 'dark' },
  security: { allowWeakSecretStorage: false },
}));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); }
  throw new Error('GUI timeout');
}

const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const out = option('--out') || mkdtempSync(join(tmpdir(), 'anycode-gallery-evidence-'));
mkdirSync(out, { recursive: true });

const app = launchSmokeElectron(spawn, { env, detached: true });
let cdp;
const call = (method, params = {}) => cdp.call(method, params).catch(error => { throw new Error(`${method}: ${error.message}`, { cause: error }); });
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expression} → ${JSON.stringify(r.exceptionDetails)}`);
  return r.result.value;
}
async function capture(name) {
  await evaluate(`(async()=>{ const s=document.createElement('style'); s.id='gallery-still'; s.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.append(s); await document.fonts.ready; document.activeElement?.blur(); })()`);
  await sleep(300);
  const png = Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  writeFileSync(join(out, name + '.png'), png);
  return createHash('sha256').update(png).digest('hex');
}

const unverified = [];
try {
  cdp = await connectIsolatedCdp({ profile, env, launcher: app, wait: poll });
  console.log('STEP', 'connect');
  await call('Page.enable');
  console.log('STEP', 'page enabled');
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  // The gallery is DEV-only and lives behind the ?view=ui-gallery query. The
  // query is read once at module load, so the page must be navigated.
  console.log('STEP', 'read href');
  await call('Runtime.enable');
  const href = await poll(async () => {
    try { const value = await evaluate(`document.readyState === 'complete' ? location.href : null`); return value; }
    catch { return null; }
  }, 60000);
  console.log('STEP', 'href', href);
  await evaluate(`location.replace('${href.split('?')[0]}?view=ui-gallery'); true`);
  let lastError = '';
  await poll(async () => {
    try { return await evaluate(`!!document.querySelector('.ak-gallery')`); }
    catch (error) { lastError = error.message; return null; }
  }, 60000).catch(error => { throw new Error(`${error.message}; last evaluate error: ${lastError}`); });
  for (const theme of ['dark', 'light']) {
    console.log('STEP', 'theme', theme);
    await evaluate(`(()=>{const items=[...document.querySelectorAll('.ak-seg__item')];const t=items.find(i=>i.textContent.trim()==='${theme}');if(t)t.click();return !!t;})()`);
    await sleep(300);
    const hash = await capture(`gallery-${theme}`);
    console.log('FRAME', `gallery-${theme}`, hash);
  }
  const states = await evaluate(`(()=>{const box=document.querySelector('.ak-choice__control');const sw=document.querySelector('.ak-switch');const b=box.getBoundingClientRect();const w=sw.getBoundingClientRect();return {buttons:document.querySelectorAll('.ak-btn').length,choices:document.querySelectorAll('.ak-choice__control').length,switches:document.querySelectorAll('.ak-switch').length,checkbox:[b.width,b.height],switch:[w.width,w.height]};})()`);
  console.log('STATES', JSON.stringify(states));
  if (!states.choices || !states.switches) unverified.push('gallery renders no choice or switch states');
} catch (error) {
  console.error('FAIL', error.message);
  try { process.kill(-app.pid); } catch { /* already gone */ }
  process.exit(1);
} finally {
  try { process.kill(-app.pid); } catch { /* already gone */ }
}
console.log(unverified.length ? 'PASS_WITH_UNVERIFIED' : 'PASS');
for (const item of unverified) console.log('UNVERIFIED', item);
process.exit(unverified.length ? 2 : 0);
