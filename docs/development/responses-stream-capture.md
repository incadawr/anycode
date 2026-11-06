# Capture a Responses gateway stream

To investigate missing reasoning or answer text, run this optional local proxy
from the repository checkout (Node 22 or later):

```sh
node scripts/capture-responses-stream.mjs --upstream https://gateway.example/v1 --out /private/tmp/responses-capture --port 8787
```

Use the gateway's actual API base URL for `--upstream`. Temporarily set the
connection's base URL in AnyCode to `http://127.0.0.1:8787/v1`, keeping its key,
model and Responses transport. Reproduce one short turn, including a tool call
if the problem happens between tools. Restore the original base URL and stop
the proxy with Ctrl+C.

Each request produces two files: `*.request.json` contains the outgoing request
body, and `*.response.sse` contains the response body bytes before SDK parsing
and before AnyCode's reasoning gate frame is inserted. No authentication headers
are written. The proxy listens only on loopback and accepts only
`POST /v1/responses`; it is inactive unless explicitly started. The files have
owner-only permissions. It preserves SSE content and ordering, but does not
preserve network chunk boundaries, timing or HTTP compression.

Before sharing, review the files: prompts, tool arguments, answers and reasoning
can contain private data. Use a short non-sensitive reproduction when possible.
Keep event types, item ids, output/content/summary indices, initial text and
reasoning deltas, and event ordering intact. Include the model id, gateway
version, AnyCode version, expected first words, and observed first words. A
screenshot or the final response JSON alone cannot show where streaming text
was lost.
