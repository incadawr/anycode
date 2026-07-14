# Contributing to AnyCode

Thanks for taking the time to contribute. AnyCode is in early alpha, so small,
well-scoped improvements and reports from real use are especially valuable.

## Before you start

- Search existing issues and pull requests before opening a new one.
- For a substantial feature or change to user-facing behaviour, open an issue
  first so we can agree on the direction.
- Do not include credentials, personal data, local profiles, screenshots with
  private content, or generated build output in issues, commits, or pull requests.
- Security vulnerabilities follow [SECURITY.md](SECURITY.md), not the public tracker.

## Development setup

AnyCode requires Node.js 22 or newer and pnpm 10.

```bash
pnpm install --frozen-lockfile
pnpm --filter @anycode/desktop dev
```

See [docs/development](docs/development/README.md) for automation, testing,
and release guidance.

## Making a change

1. Fork the repository and create a branch from `master`.
2. Use a short descriptive branch name, such as `feature/session-export`,
   `fix/mcp-timeout`, or `docs/setup-guide`.
3. Keep the change focused. Include tests when behaviour changes.
4. Run the narrowest relevant checks, then typecheck:

   ```bash
   pnpm test
   pnpm -w typecheck
   ```

   For desktop UI changes, also run:

   ```bash
   pnpm --filter @anycode/desktop build
   ```

5. Open a pull request against `master` using the provided template.

## Pull requests

Describe the user-visible result, implementation approach where it matters,
and the checks you ran. Link the related issue when one exists.

Maintainers use squash merges to keep `master` readable. By submitting a pull
request, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE).
