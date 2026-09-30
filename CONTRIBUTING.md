# Contributing to EnvSync

EnvSync is a P2P encrypted `.env` sync tool. Node.js, no frameworks, `node:test` for tests, Electron for the optional tray app.

Repo: https://github.com/RismanRJ/envsync

## Workflow

No direct pushes to `main`. All changes go through a pull request.

1. Fork the repo.
2. Clone your fork and create a branch:
   ```
   git checkout -b my-change
   ```
3. Make your change.
4. Push the branch to your fork and open a PR against `main`.

## Setup and tests

```
npm install
node --test test/
```

All tests must pass before a PR is merged. If you fix a bug or add behavior, add a test in `test/`.

## Pull requests

- Every change needs a PR, no exceptions.
- Keep PRs small and focused on one thing.
- Describe what changed and why.
- Tests must pass.

## Secrets

Never commit `.env` files, keys, tokens, or any other secrets. This is a tool for syncing secrets, so be careful: check `git diff --staged` before committing and do not use real secrets in tests or fixtures.

## Code style

- No comments unless a maintainer asks for them.
- No unnecessary abstractions. Do the simple thing.
- Match the existing patterns in the file and repo.
- No new dependencies for things a few lines or the standard library can do.

## Tray app

The Electron tray app is a separate package in `packages/tray/`, with its own `package.json`. Changes to the tray go there, not in the core package.

## License

By contributing, you agree your contributions are licensed under the MIT License.
