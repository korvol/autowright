# Contributing to Autowright

Thanks for your interest in contributing to Autowright.

## Getting Started

1. Fork the repository
2. Clone your fork
3. Create a branch from `main`
4. Make your changes
5. Open a pull request

## Branch Naming

Use prefixed branch names:

- `feat/description` — new features
- `fix/description` — bug fixes
- `docs/description` — documentation changes
- `refactor/description` — code restructuring
- `test/description` — adding or updating tests
- `chore/description` — tooling, CI, dependencies

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add runner retry logic
fix: handle null classifier return
docs: update API examples in README
test: add classifier resolution tests
refactor: simplify step execution loop
chore: update TypeScript config
```

- Start with the type prefix followed by a colon and space
- Use lowercase, imperative mood ("add" not "added" or "adds")
- Keep the first line under 72 characters
- Add a body if the "why" isn't obvious from the title

## Pull Requests

- All changes go through pull requests — no direct pushes to `main`
- One approval required to merge
- Keep PRs focused — one logical change per PR
- Write a clear description of what the PR does and why

## Code Style

- TypeScript
- Follow existing patterns in the codebase
- Write tests for new functionality

## Questions?

Open an issue if something is unclear.
