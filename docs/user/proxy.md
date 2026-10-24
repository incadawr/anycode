# Proxy and network

**Settings → Network** owns the proxy configuration. Proxy profiles live in
`~/.anycode/settings.json` under `network`. Proxy passwords do not: they go to
the secrets vault and the profile refers to them.

## Named proxy profiles

A profile is one reusable proxy definition. Each has a name and a mode:

- **Manual**: a host name and port (the **Host name** and **Port number**
  fields). Optionally tick the HTTPS option when the proxy itself is reached over
  TLS. A login and password go in the **Proxy authentication** section; the
  password is stored in the vault.
- **System proxy**: ask the operating system what it would use, including PAC
  scripts, and pass that answer to child processes.

Each profile can carry a **No proxy for** list in `NO_PROXY` syntax: host
suffixes, comma-separated. Loopback addresses are always bypassed, and your list
adds to that default.

In `settings.json` a manual profile looks like this:

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

The profile editor has a **Check** section. Enter a target and test the profile
before you rely on it.

## Application default

`network.proxyRef` names the profile the whole app uses by default. It is the
bottom of every proxy choice. The picker's **No proxy** option removes the key,
because there is nothing below the application to inherit. Without a `network`
key the app runs direct.

## Per-connection proxy

In the connection drawer (Settings → Provider), the **Proxy** picker offers
**Use application proxy**, **No proxy**, or one of your profiles. Use it when one
provider must go through a corporate proxy and the others must not.

## Per-engine proxy

The Codex and Claude panes have their own **Proxy** picker with the same
choices. A Codex account profile is an auth home, not a network path, so the
proxy is configured here and not on the account.

An `HTTP(S)_PROXY` (or `NO_PROXY`) variable already set in the app's launch
environment takes precedence over these pane settings for the CLI's processes.

## How to verify it applied

Proxy changes reach new sessions and newly started engine processes. After you
change a profile, reopen **Settings → Network** and check the profile's **Used
by** line, then start a new session and run a network-dependent tool, such as a
provider call or WebFetch. A wrong proxy shows up as a connection error in that
tool's output.
