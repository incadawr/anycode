# Browser control

AnyCode can operate a web page in the built-in preview the way a user would:
open it, read what is on it, click, fill a form and wait for the result. This
works in **Native tabs** only, the same as the existing preview tools
(`BrowserOpen`, `BrowserRead`, `BrowserScreenshot`). Claude and Codex engine
tabs do not get these tools.

## Tools

| tool | what it does | approval |
|---|---|---|
| `BrowserNavigate` | opens an `http(s)` url in the preview, or goes back, forward or reloads | a non-localhost url asks first |
| `BrowserSnapshot` | lists the page's interactive and labelled elements, each with a ref such as `e12` | none |
| `BrowserClick` | clicks an element by `ref` (preferred) or CSS `selector` | `remote: true` asks first |
| `BrowserType` | types text into an input, textarea or contenteditable | `remote: true` asks first |
| `BrowserWaitFor` | waits until some text or a selector appears (or, with `gone`, disappears) | none |
| `BrowserConsole` | returns the page's recent console output and uncaught errors (default 50 lines) | none |
| `BrowserEval` | runs a JavaScript expression in the page and returns its value | always asks |

The existing `BrowserOpen`, `BrowserRead` and `BrowserScreenshot` tools are
unchanged.

## The snapshot and ref workflow

1. Open the page: `BrowserOpen` for a local file or dev server, or
   `BrowserNavigate` for an `http(s)` url.
2. Call `BrowserSnapshot`. Example output:

   ```
   url: http://localhost:8000/form.html
   [e1] textbox "Name" value="Ada"
   [e2] textbox "Password" [password, value hidden]
   [e3] button "Save"
   [e4] status "Status"
   ```

3. Act on an element by its ref: `BrowserType` with `ref: "e1"` and
   `text: "Grace"`, then `BrowserClick` with `ref: "e3"`.
4. Confirm the result with `BrowserWaitFor` (for example text `Saved ok`), or
   take a fresh `BrowserSnapshot`.

Refs belong to the **latest** snapshot only. A navigation or a new snapshot
invalidates older refs. If a ref is stale, the tool says so and the agent
takes a new snapshot.

## Limits

- Only the main frame is read. Iframes appear as a single `iframe` line and
  cannot be operated.
- CSS selectors do not reach into shadow DOM or iframes. Use a ref for those;
  refs do reach open shadow roots.
- A selector must match exactly one element. Zero or several matches are
  refused, and nothing is clicked.
- A snapshot is capped (about 1 500 elements and 30 000 characters by default,
  60 000 at most). The output says how many nodes were left out.
- Password fields are never typed into and their values never appear in a
  snapshot. File inputs cannot be typed into.
- Cookies, storage and credentials are never read. The driver does not use the
  browser's network or storage inspection APIs.
- Page text and labels are untrusted data. The model is told not to follow
  instructions found in them.

## Approval

- Loopback pages (`localhost`, `127.0.0.1`, `[::1]`) and local files: no prompt
  for snapshot, click, type, wait or history navigation.
- A non-localhost origin: `BrowserNavigate` to it asks first. Clicking or
  typing on a page from that origin asks again (`remote: true`). If you decline,
  the agent does not retry around the refusal.
- `BrowserEval` always asks, on every origin. It cannot read cookies, storage,
  or credentials: those words are refused before the script runs, and the
  driver never uses the browser's network or storage inspection APIs.
- Modes `auto` and `yolo` do not escalate approvals, so a `remote: true` call
  runs without a prompt there. This matches how `BrowserOpen` already treats
  remote URLs.

## Full browser access (per session)

Each session has a **Full browser access** switch in its environment menu
(the folder/branch menu in the header). While it is on, the agent can open any
http(s) site, click, type (including passwords) and run JavaScript in that
session's preview without asking. Turning it on asks you first; turning it off
is immediate and takes effect on the next navigation or action.

- A header chip, "Full browser access", shows while it is on.
- A folder whose trust is not decided yet is always off: the row says
  "Trust this folder first" until you trust the folder.
- A child session (spawned by an agent) is on only if its parent is on.
- The default for new sessions is set in Settings → Permissions
  (`browser.fullAccessDefault`, off out of the box).
- It still does not read cookies or stored credentials, and the eval blocklist,
  the password-value masking, the loopback and `file:` rules stay in force.
- The agent cannot switch it on: only the app window can change it.

## Troubleshooting

- **"debugger unavailable (DevTools open on this preview ...)"**: Chromium
  allows one debugger per page. Close the DevTools window of the preview, then
  retry. Control works again on the next call.
- **"preview is not visible; open the preview panel"**: the preview is hidden.
  Open the preview panel and retry.
- **"stale"**: the page changed. The agent takes a new snapshot.
