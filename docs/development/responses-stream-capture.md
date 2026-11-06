# Capture a Responses gateway stream

To investigate missing reasoning or answer text, run this optional local proxy
from the repository checkout (Node 22 or later):

Find a temporary output path (works on macOS, Linux and Windows):

```sh
node -p "require('node:path').join(require('node:os').tmpdir(), 'responses-capture')"
```

Use the printed path in place of `<temporary-path>` below:

```sh
node scripts/capture-responses-stream.mjs --upstream https://gateway.example/v1 --out "<temporary-path>" --port 8787
```

Use the gateway's actual API base URL for `--upstream`. Temporarily set the
connection's base URL in AnyCode to `http://127.0.0.1:8787/v1`, keeping its key,
model and Responses transport. Reproduce one short turn, including a tool call
if the problem happens between tools. Restore the original base URL and stop
the proxy with Ctrl+C.

A completed request produces two files: `*.request.json` contains the outgoing request
body, and `*.response.sse` contains the response body bytes before SDK parsing
and before AnyCode's reasoning gate frame is inserted. No authentication headers
are written. The proxy listens only on loopback and accepts only
`POST /v1/responses`; it is inactive unless explicitly started. New files and newly created output
directories have owner-only permissions; an existing output directory keeps its
permissions. It preserves SSE content and ordering, but does not
preserve network chunk boundaries, timing or HTTP compression.

An upstream failure can leave only the request file. Client aborts or Ctrl+C can
leave a truncated SSE file and lose buffered writes, without a completeness
marker. Wait for the request to finish before stopping; a partial capture does
not prove that the gateway omitted the remaining events.

Before sharing, review the files: prompts, tool arguments, answers and reasoning
can contain private data. Use a short non-sensitive reproduction when possible.
Keep event types, item ids, output/content/summary indices, initial text and
reasoning deltas, and event ordering intact. Include the model id, gateway
version, AnyCode version, expected first words, and observed first words. A
screenshot or the final response JSON alone cannot show where streaming text
was lost.
