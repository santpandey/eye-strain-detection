---
name: release
description: Run before tagging/cutting a blinkwell release (vX.Y.Z) — version bumps, green-checks, push+tag order, and post-release verification for GitHub assets + PyPI.
---

# Release checklist — run every time before tagging

Tag pushes trigger `release.yml` (GitHub Release assets) and
`publish-pypi.yml` (PyPI). PyPI rejects re-uploaded filenames forever, so the
version bump MUST land before the tag. In order:

1. **Bump the version** in BOTH `cli/pyproject.toml` and
   `cli-rs/Cargo.toml` to the new `X.Y.Z` (keep them in sync).
2. Run `cargo check`/`build` in `cli-rs/` so `Cargo.lock` picks up the new
   version — commit the lockfile too.
3. Update the hardcoded version chip in `site/index.html` (nav, `vX.Y.Z`).
4. Verify green: `cargo fmt --check`, `cargo clippy --release`,
   `cargo test --release`, `cd cli && .venv/bin/python -m pytest tests/`,
   `npm test` if `src/` changed.
5. `git push` — moves `main` (Netlify redeploys `site/` on this push).
6. `git tag vX.Y.Z && git push origin vX.Y.Z` — pushes the tag ref →
   triggers both workflows. (`git push --follow-tags` combines 5+6.)
7. Check the Actions tab: `release` should produce
   `blinkwell-{linux-x64,macos-arm64,windows-x64,windows-arm64}.{tar.gz,zip}`;
   `publish-pypi` should upload `blinkwell-X.Y.Z` successfully.
8. Verify: `releases/latest/download/` asset names still match what
   `site/install.{sh,ps1}` fetch, and `pypi.org/pypi/blinkwell/json` shows
   the new version.

## Hard rules learned the hard way

- **Shipped-logic changes warrant a release.** A tag is a frozen snapshot —
  commits landing on main after it never reach users until the next tag.
  After any change to `cli-rs/` or `cli/` core logic (or site/docs copy that
  describes new behavior), cut a new `vX.Y.Z` the same day — never let the
  site or README promise behavior `releases/latest` can't deliver.
- **PyPI is immutable**: a tag pointing at a commit whose pyproject version
  already exists on PyPI fails with "File already exists". Never retag to
  "re-publish" — bump the version instead.
- **Deleting a remote tag does NOT delete its GitHub Release** — if a tag
  must move, delete the Release on the releases page too, or stale assets
  persist alongside new ones.
- Re-running a failed tag-triggered workflow reuses the workflow file FROM
  THE TAG, not from main — fix the file on main, then re-run via
  `workflow_dispatch` (or move the tag).
