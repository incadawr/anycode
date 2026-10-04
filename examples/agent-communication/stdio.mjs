/** Portable MCP stdio -> local JSON Streamable HTTP adapter; Node >=22. */
import { readFile, lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const discoveryPath = process.argv[2];
if (!discoveryPath) throw new Error('Usage: node stdio.mjs /absolute/path/to/communication.json');
const metadata = await lstat(discoveryPath);
if (!metadata.isFile() || (metadata.mode & 0o077)) throw new Error('Discovery must be a private regular file (0600)');
const discovery = JSON.parse(await readFile(discoveryPath, 'utf8'));
const endpoint = new URL(discovery.url);
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp') throw new Error('Only loopback AnyCode endpoints are allowed');
if (typeof discovery.token !== 'string' || discovery.token.length < 32) throw new Error('Invalid discovery token');
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
    const response = await fetch(endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`AnyCode endpoint returned HTTP ${response.status}`);
    const body = await response.text();
    if (body) process.stdout.write(`${JSON.stringify(JSON.parse(body))}\n`);
  } catch (error) {
    if (request?.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Communication failed' } })}\n`);
    else process.stderr.write('AnyCode communication notification failed\n');
  }
}
