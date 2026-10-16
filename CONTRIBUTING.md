# Contributing to brushrouter

Thanks for your interest in contributing. We accept **meaningful contributions** — changes that fix a real bug, add a genuinely useful provider, improve documentation, or strengthen tests.

## What we accept

- **Bug fixes** — something that works in the README/docs but not in practice, crashes a route, or leaks credentials (the redactor is load-bearing; a redaction bug is a top priority).
- **New provider backends** — a route that reuses something people already pay for (a subscription CLI, an OAuth login) fits the project's zero-new-spend philosophy. See `src/providers/` for the pattern each backend follows.
- **Prompt library & recipes** — a *tested* addition that produces a visibly better image than the model's own prompting, and passes `npm run recipes:check`.
- **Docs** — clarifications, corrections, or a missing step in `setup`/`doctor` coverage.
- **Tests** — every bug fix should come with a failing test before the fix.
- **Agent MCP integrations** — wider coverage or fixes in `src/util/mcp-install.js`.

## What we don't accept

- Features requiring a new runtime dependency (the shipped CLI is dependency-free; keep it that way unless there's a very strong reason).
- Rewrite-the-world PRs. Small, focused changes.
- Style-only PRs: formatting, renaming, or anything with no functional effect.
- Hand-edits to anything generated: `data/styles/` corpus changes must be re-vendored via `scripts/vendor-styles.mjs`, never edited by hand.

## Ground rules

1. **Node.js 20+.**
2. **No new dependencies.** Use Node stdlib (`node:`, `node:test`).
3. **Credentials never appear in model-visible output.** Anything an agent can see goes through the redactor. If your change adds a new output path, it must be redacted and covered by a test.
4. **No hardcoded paths or user-specific logic.** Discover what exists (`src/util/discover.js`), never assume.
5. **Fail loud, fall back.** A broken route should degrade to the next provider, not hang or crash the CLI.

## How to contribute

1. **Open an issue first** for anything that isn't a small fix or doc change. Describe the bug (with `brushrouter doctor` output, redacted) or the provider you want to add. This avoids wasted work — we'll say quickly if it's out of scope.
2. **Fork & branch.** `git clone` / fork, then `npm link` and `brushrouter setup` to get a working install.
3. **Make the change.** Keep the diff focused — one fix or one feature per PR.
4. **Test:**

   ```bash
   npm test            # node --test tests/*.test.js — must pass
   npm run doctor      # if you touched setup/providers/discovery
   ```

   New logic (a branch, a parser, a route) gets at least one test in `tests/`. Existing tests must still pass.
5. **Open the PR** with a short description: what changed, why, and how you verified it (the exact command and result). Link the issue.

## PR checklist

- [ ] Issue linked (for anything non-trivial)
- [ ] `npm test` passes
- [ ] No new dependencies in `package.json`
- [ ] No credentials/secrets in code, logs, or test fixtures
- [ ] Docs updated if behavior changed (README and/or `docs/TECHNICAL.md`)
- [ ] CHANGELOG.md updated (new bullet under the topmost `## [x.y.z]` heading)

## Reporting bugs

Open an issue and include:

- `brushrouter doctor` output (**redact any tokens** — run through the config, don't paste raw auth stores)
- The command you ran and the full output
- Node version and OS
- What you expected vs. what happened

## Security

Found a credential-leak or auth-handling issue? **Do not open a public issue.** Use GitHub's private security advisory for this repo.

## License

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).
