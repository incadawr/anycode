/** Credential-free preliminary T1 acceptance driver. */
import { createPeerSmoke } from './session-peers-smoke.mjs';

const scenarios = [
  ['Parent and API steer at a tool barrier', 'Driver does not yet create a child or hold a tool call.'],
  ['Identical texts and retried id', 'Requires the child delivery driver.'],
  ['Child pane and reload', 'Requires the child delivery driver and pane controls.'],
  ['Cancel before seam', 'Requires the child delivery driver.'],
  ['Early send before first turn', 'Requires control of child startup.'],
];
const driver = await createPeerSmoke({ targetEngine: 'core' });
try {
  await driver.start();
  console.log('PASS isolated local provider and desktop launch');
} catch (error) {
  driver.reportFailure(error);
  console.log(`FAIL isolated local provider and desktop launch: ${error.message}`);
  process.exitCode = 1;
} finally {
  await driver.close();
}
for (const [name, reason] of scenarios) console.log(`NOT CHECKED ${name}: ${reason}`);
if (!process.exitCode) process.exitCode = 2;
