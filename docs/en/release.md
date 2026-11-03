> Back to [README](../../README.md)

# 📦 Release process

The order matters; two of these steps exist because a bad release shipped without them.

```bash
# 1. Bump the version. SERVER_VERSION reads package.json, nothing else.
npm version patch --no-git-tag-version
#    Then edit CHANGELOG.md: turn [Unreleased] into the new version.

# 2. Run the offline suites locally (same set as CI, no tokens, no DSH needed for most).
node test/run.mjs
node test/package-check.mjs
npm run check:release   # version / CHANGELOG / doc links / package contents agree

# 3. Verify the tarball itself: builds, installs, starts.
npm pack --dry-run
#    Then in a temp dir: npm install <tgz> && node_modules/.bin/dsh-any-agent --version

# 4. Tag and push (wait for CI before publishing).
git add -A && git commit -m "chore: release x.y.z"
git tag vx.y.z && git push origin main --tags
# The pushed tag triggers .github/workflows/release.yml, which creates the
# GitHub Release with generated notes; no local gh CLI is required.

# 5. Publish to npm and verify.
npm publish --access public
npm view dsh-any-agent version
# A 404 right after publish is usually propagation, not failure: npm returns
# 202 and the registry can lag briefly. Confirm the local npm log shows the
# version before retrying.
```
