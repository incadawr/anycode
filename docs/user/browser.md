# Browser control

AnyCode can operate a web page in the built-in preview the way a user would:
open it, read what is on it, click, fill a form and wait for the result. This
works in **Native tabs** and in **engine tabs**: Claude and Codex tabs get the
same tools through AnyCode's tool bridge. Claude shows them as
`mcp__anycode__browser_*`, Codex as `anycode_browser_*`, and the transcript
names them `BrowserOpen`, `BrowserNavigate`, ....

## Engine tabs (Claude and Codex)

1. Same tools, **Full browser access** switch and domain policy as native tabs.
   Engine tabs request approval directly for calls marked as needing it.
2. Approvals always apply in these tabs (there is no auto/yolo mode that
   skips them): a remote navigation and `remote:true` click/type ask first
   unless Full browser access is on; `BrowserEval` asks always, even with it
   on, and no saved always-allow rule exempts it.
3. `BrowserOpen` of a remote URL asks even with Full browser access on. In
   Native tabs it remains high-risk and follows the permission mode.
4. A Codex session resumed after an app restart gets the browser tools back
   (the declarations ride `thread/resume`); a Codex session created before
   this version keeps its old tool set — start a new Codex session to get the
   browser tools.
5. Resumed Codex history shows past browser calls as cards (tool name,
   arguments, result text; screenshots show only a text placeholder).
6. Child sessions have no browser tools.
7. Screenshots reach the model; the transcript shows only the text line
   (e.g. "Screenshot of <url> (WxH) attached."). In a Codex tab whose current
   model is text-only (per Codex's own model catalog), the screenshot is
   refused with the same "model is not marked image-capable" error a native
   tab produces; the Claude CLI exposes no per-model image capability, so in
   Claude tabs the screenshot tool is always allowed.

## Tools

| tool | what it does | approval |
|---|---|---|
| `BrowserNavigate` | opens an `http(s)` url in the preview, or goes back, forward or reloads | remote URL escalates unless Full browser access is on |
| `BrowserSnapshot` | lists the page's interactive and labelled elements, each with a ref such as `e12` | none |
| `BrowserClick` | clicks an element by `ref` (preferred) or CSS `selector` | `remote: true` escalates unless Full browser access is on |
| `BrowserType` | types text into an input, textarea or contenteditable | `remote: true` escalates unless Full browser access is on |
| `BrowserWaitFor` | waits until some text or a selector appears (or, with `gone`, disappears) | none |
| `BrowserConsole` | returns the page's recent console output and uncaught errors (default 50 lines) | none |
| `BrowserEval` | runs arbitrary JavaScript in the page; the script has the page's own reach and can read that page's cookies and storage | fresh approval whenever allowed |

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
- Password fields can be typed into only with Full browser access on; their
  values never appear in a snapshot. File inputs cannot be typed into.
- `BrowserEval` runs arbitrary page JavaScript, so the script can read the
  shown page's cookies and storage, and anything else the page can see,
  including values typed into its fields (a non-HttpOnly login cookie and a
  password you typed into the page are both reachable this way). HttpOnly
  cookies, other preview partitions and OS or browser-stored credentials stay
  out of reach. The driver itself does not use the browser's network or
  storage inspection APIs.
- Page text and labels are untrusted data. The model is told not to follow
  instructions found in them.

## Approval

Browser actions in Native tabs follow the [permission mode](permissions.md#the-mode-ladder)
and saved rules: plan denies side-effecting actions, build and edit ask, auto
asks for high-risk actions, and yolo allows them. Remote `BrowserOpen` is
high-risk regardless of Full browser access. Remote `BrowserNavigate` and
click/type marked `remote: true` are high-risk when Full browser access is off;
with it on they do not receive that escalation. Local navigation, click and type
still follow the mode's ordinary side-effect rules. Engine tabs instead ask for
calls marked as needing approval, regardless of mode. Saved rules may resolve
ordinary asks.

`BrowserEval` requires a fresh approval whenever it is allowed to run; no mode,
Full browser access switch or saved rule bypasses it. Native plan mode denies
it. Its script has the page's own reach, including non-HttpOnly cookies,
storage and values typed into fields. If you decline an action, the agent must
not retry around the refusal.

## Full browser access (per session)

Each session has a **Full browser access** switch in its environment menu
(the folder/branch menu in the header). While it is on, the agent can open any
http(s) site, click and type (including passwords) in that session's preview
without the remote-action escalation. The session mode can still require approval;
remote `BrowserOpen` remains high-risk, and `BrowserEval` still requires a fresh
approval whenever allowed. Turning it on asks
you first; turning it off is immediate and takes effect on the next navigation
or action.

- A header chip, "Full browser access", shows while it is on.
- A folder whose trust is not decided yet is always off: the row says
  "Trust this folder first" until you trust the folder.
- A child session (spawned by an agent) is on only if its parent is on.
- The default for new sessions is set in Settings → Permissions
  (`browser.fullAccessDefault`, off out of the box).
- `BrowserEval` can read the shown page's cookies and storage, and anything
  else the page can see, including values typed into its fields, with the
  same limits as above (HttpOnly cookies, other partitions and OS or
  browser-stored credentials stay out of reach). The snapshot password
  masking, the loopback and `file:` rules stay in force.
- The agent cannot switch it on: only the app window can change it.

## Troubleshooting

- **"debugger unavailable (DevTools open on this preview ...)"**: Chromium
  allows one debugger per page. Close the DevTools window of the preview, then
  retry. Control works again on the next call.
- **"preview is not visible; open the preview panel"**: the preview is hidden.
  Open the preview panel and retry.
- **"stale"**: the page changed. The agent takes a new snapshot.
