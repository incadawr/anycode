# Maintaining a fork

Prefer a private plugin package when configuration and account data can be
supplied through the supported plugin mechanisms. See the [plugin authoring guide](plugins-authoring.md)
and [user plugin guide](../user/plugins.md) for
packaging, installation, and updates. A branded fork is appropriate when the
application itself must differ, but it adds ongoing integration work.

For a branded build, choose distinct `productName`, `appId`, and executable
name. Configure separate Electron `userData` and AnyCode data, profile and
secret paths; changing a product name alone does not isolate `~/.anycode`.
These path customizations require code changes: there is no general branded
profile switch today. Test a parallel installation before distributing it.
Use your own update feed and release/download links, and follow the current
[release policy](release.md) for signing and distribution. Never embed secrets
in the application or a plugin package.

Record the upstream commit or tag and keep your integration in a separate
branch and reviewable pull request. Keep the diff small; rebase or merge the
chosen upstream release deliberately, resolve conflicts, and run the test
gates. Test upgrades against copies of existing settings and profiles. Before
an upgrade, keep a compatible backup; test rollback with that backup rather
than assuming a newer alpha data format can be read by an older application.
There is no guarantee of conflict-free merges or alpha-format compatibility.

The [account source example](../../examples/account-source/) uses synthetic
`example.com` endpoints. Keep real endpoints, rates and credentials in the
private gateway and package. The source contract is a narrow JSON protocol;
existing plugin installation and update mechanisms still apply.
