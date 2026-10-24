# Proxy and network

Settings → Network owns all proxy configuration in the app. Proxy state is
kept in `~/.anycode/settings.json` (`network` key), and proxy **passwords**
never are — they live in the secrets vault and are referenced by profile.

Requires AnyCode 0.0.35 or newer.

## Named proxy profiles

A profile is one reusable proxy definition:

- **Manual** — you give the `http(s)://host:port` URL; credentials (login +
  password) go to the vault, never into the URL string or the settings file.
- **System** — ask the operating system what it would do (including PAC
  scripts) and materialize that answer for child processes.

Each profile can carry a **no-proxy list** in honest `NO_PROXY` syntax (host
suffixes, comma-separated). Loopback is always bypassed; your list adds to
that, it never replaces it.

```json
{
  "network": {
    "proxyProfiles": [
      { "id": "proxy-office", "name": "Office", "mode": "manual", "url": "http://127.0.0.1:8888", "noProxy": "internal.example.com,corp.example.com" }
    ],
    "proxyRef": "proxy-office"
  }
}
```

## Default proxy

`network.proxyRef` names the profile the **whole app** uses by default — the
bottom rung of every proxy ladder. Choosing "No proxy" here clears the key
(nothing is below the app to inherit). Omit the `network` key entirely and the
app runs direct.

## Per-connection proxy

Each provider connection (Settings → Provider) can select its own proxy
profile, overriding the app default for that connection's traffic only. This
is the right tool when one provider must go through a corporate proxy and the
rest must not.

## Per-engine proxy

The Codex and Claude panes each route their CLI's traffic through a chosen
proxy profile. Note the split: a Codex *account profile* is an auth home, not
a network path — the proxy is configured separately in Settings → Network.

## Environment overrides

`ANYCODE_CODEX_PROXY_URL` and `ANYCODE_CLAUDE_PROXY_URL` exist as
environment carriers, and a shell-exported `http(s)_proxy` family still wins
where present. They are plumbing for automation and unusual setups — the
Settings panes are the owner surface; prefer them.

## How to verify it applied

Proxy changes reach **new** sessions and newly spawned engine children. After
changing a profile: restart the app, open Settings → Network and confirm the
profile list and the default badge, then start a new session and exercise a
network-dependent tool (a provider call, a WebFetch). A wrong proxy shows up
as connection timeouts in that tool's error, not in the Network pane.
