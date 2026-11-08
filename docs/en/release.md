> Back to [README](../../README.md)

# 📦 Release process

The order matters; two of these steps exist because a bad release shipped without them.

```bash
# 1. Bump the version. SERVER_VERSION reads package.json, nothing else.
npm version patch --no-git-tag-version
#    Then edit CHANGELOG.md:
#      - turn [Unreleased] into the new version (that section IS the GitHub Release notes, written for users)
#      - link block at the bottom: [Unreleased] → compare/vx.y.z...HEAD, plus [x.y.z]: …/compare/vprevious...vx.y.z

# 2. Run the offline suites locally (same set as CI, no tokens, no DSH needed for most).
node test/run.mjs
node test/package-check.mjs
npm run check:release   # version / this CHANGELOG section and its links / release notes build / doc links / package contents
npm run docs:counts:check   # check counts in tests.md and the CI comment = the report node test/run.mjs just wrote
#    A mismatch means tests changed without the numbers being refreshed:
#    node test/run.mjs --all --report .state/test-report.json && npm run docs:counts
#    (model-suite numbers only move with a report made using --all; see "After changing tests" in docs/en/tests.md)
node scripts/release-notes.mjs x.y.z   # preview the notes the Release page will show

# 3. Verify the tarball itself: builds, installs, starts.
npm pack --dry-run
#    Then in a temp dir: npm install <tgz> && node_modules/.bin/dsh-any-agent --version

# 4. Merge into main (via PR, after CI is green), then tag that main commit and push the tag.
git tag -a vx.y.z <commit on main> -m "vx.y.z"
git push origin vx.y.z
```

**Everything after the tag push is done by `.github/workflows/release.yml` — no local `npm publish`:**

1. **GitHub Release**: notes are this version's CHANGELOG section (`scripts/release-notes.mjs`), followed by the install command and a compare link. If the Release already exists only its notes are updated, so re-running is safe.
2. **npm publish**: checks the tag matches `package.json`, runs `check:release` and `package-check`, then publishes with **npm Trusted Publishing** (GitHub OIDC) and provenance — no `NPM_TOKEN`, and the npm page shows the package was built by this repository's GitHub Actions. Skipped if the version is already on npm.

**One-time setup**: npmjs.com → package `dsh-any-agent` → Settings → Trusted Publisher → GitHub Actions, repository `xmtlzzz/dsh-any-agent`, workflow file `release.yml`. Until then the npm job fails with an auth error (the GitHub Release is unaffected); publish locally with `npm publish` as a fallback, and a later re-run simply skips npm.

**Refreshing an old Release's notes**: Actions → release → Run workflow with an existing tag (e.g. `v0.6.2`). The npm job skips because the version exists.

**A 404 right after publishing is not a failure.** npm ingests new versions asynchronously (`PUT 202`, not `200`), so the registry can lag for a minute. For a CI publish read the npm job's log; for a local publish confirm the npm log shows `http fetch PUT 202`, then wait and check `npm view dsh-any-agent dist-tags`.
