/** Forwards the server tool list unchanged, including create_session and close_session. */
/** Portable MCP stdio -> local JSON Streamable HTTP adapter; Node >=22. */
import { readFile, lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const discoveryPath = process.argv[2];
if (!discoveryPath) throw new Error('Usage: node stdio.mjs /absolute/path/to/communication.json');
async function loadDiscovery() {
  const metadata = await lstat(discoveryPath);
  if (!metadata.isFile() || (metadata.mode & 0o077)) throw new Error('Discovery must be a private regular file (0600)');
  const discovery = JSON.parse(await readFile(discoveryPath, 'utf8'));
  const endpoint = new URL(discovery.url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp') throw new Error('Only loopback AnyCode endpoints are allowed');
  if (typeof discovery.token !== 'string' || discovery.token.length < 32) throw new Error('Invalid discovery token');
  return { discovery, endpoint };
}
// Loaded per message, never cached: AnyCode rewrites the discovery file on every
// start (new port, new token) and removes it while it is down. Reading it only at
// startup would either pin the adapter to a retired endpoint or make it exit when
// the client starts it during a restart.
let discovery;
let endpoint;
async function post(request) {
  return fetch(endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(30000),
  });
}
/**
 * Sends one message to the endpoint the discovery file names right now. A cached
 * endpoint keeps calls pointed at a retired port, and the reset of a stale
 * keep-alive socket cannot be retried safely (the request may have been delivered).
 */
async function exchange(request) {
  ({ discovery, endpoint } = await loadDiscovery());
  let response;
  try {
    response = await post(request);
  } catch (error) {
    // A refused connection cannot have delivered the request: the host may have
    // restarted and written a new discovery file just after it was read.
    if (error?.cause?.code !== 'ECONNREFUSED') throw error;
    ({ discovery, endpoint } = await loadDiscovery());
    response = await post(request);
  }
  if (response.status === 401) {
    // The token can be regenerated between the read above and this request.
    ({ discovery, endpoint } = await loadDiscovery());
    response = await post(request);
  }
  return response;
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
    const response = await exchange(request);
    if (!response.ok) throw new Error(`AnyCode endpoint returned HTTP ${response.status}`);
    const body = await response.text();
    if (body) process.stdout.write(`${JSON.stringify(JSON.parse(body))}\n`);
  } catch (error) {
    if (request?.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Communication failed' } })}\n`);
    else process.stderr.write('AnyCode communication notification failed\n');
  }
}
