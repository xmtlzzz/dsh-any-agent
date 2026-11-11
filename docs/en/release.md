> Back to [README](../../README.md)

# 📦 Release process

The order matters; two of these steps exist because a bad release shipped without them.

```bash
# 1. Bump the version. SERVER_VERSION reads package.json, nothing else.
npm version patch --no-git-tag-version
#    Bump both versions in server.json too (top level and packages[0]); check:release verifies them.
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

1. **npm publish**: checks the tag matches `package.json`, runs `check:release` and `package-check`, then publishes with **npm Trusted Publishing** (GitHub OIDC) and provenance — no `NPM_TOKEN`, and the npm page shows the package was built by this repository's GitHub Actions. Skipped if the version is already on npm. The job finishes only once npm actually serves the version.
2. **GitHub Release**: created only after the npm job. Notes are this version's CHANGELOG section (`scripts/release-notes.mjs`), followed by the install command and a compare link. If the Release already exists only its notes are updated, so re-running is safe. It comes after npm because directories such as Glama rebuild on a new GitHub Release with `npm install -g dsh-any-agent`; a Release that arrives first gets the previous version (on v0.6.4 the Release was public about 2.7 minutes before npm served it).
3. **MCP Registry**: after npm, the workflow logs in to the official MCP Registry with its own GitHub OIDC token (the `io.github.xmtlzzz/*` namespace) and publishes `server.json`. The registry checks ownership through the `mcpName` field inside the npm package, which is why it runs after npm. `mcp-publisher` is pinned and its signature is verified with cosign before it runs.

**Optional release gate (model suites)**: add a repository variable `MODEL_SUITE_RUNNER` (Settings → Secrets and variables → Actions → Variables) holding the label of a self-hosted runner that has DSH, a provider and credentials. With it set, a tag push first runs `node test/run.mjs --all` on the tagged commit on that runner, and npm publish waits for it; a failure stops the release before anything is published. Without the variable the job is skipped and the flow is unchanged. Re-running an old tag by hand (to refresh Release notes) does not trigger it. Live suites must not overlap (`cleanup.mjs` deletes every test session): the workflow serializes them with a concurrency group, but do not run `--all` by hand on that runner at the same time.
**One-time setup**: npmjs.com → package `dsh-any-agent` → Settings → Trusted Publisher → GitHub Actions, repository `xmtlzzz/dsh-any-agent`, workflow file `release.yml`. Until then the npm job fails with an auth error and no GitHub Release is created; publish locally with `npm publish` as a fallback, then re-run: the npm job skips and the Release is created.

**Refreshing an old Release's notes**: Actions → release → Run workflow with an existing tag (e.g. `v0.6.2`). The npm job skips because the version exists.

**A 404 right after publishing is not a failure.** npm ingests new versions asynchronously (`PUT 202`, not `200`), so the registry can lag for a minute. For a CI publish read the npm job's log; for a local publish confirm the npm log shows `http fetch PUT 202`, then wait and check `npm view dsh-any-agent dist-tags`.
