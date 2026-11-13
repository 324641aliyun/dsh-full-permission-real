# Publishing to the DSH plugin market

DSH has **no central marketplace and ships no index source**. "Publishing" means
two independent things:

1. **Making the bundle installable** — a public npm package **or** a public Git
   repository pinned to a commit. This project publishes **from the public Git
   repository**, because the npm account's 2FA is a passkey that CLI publishing
   cannot satisfy without a bypass-2FA token; the market's Git install target is
   a first-class format-1 source and installs the same package.
2. **Hosting a format-1 index JSON** on any static `http(s)` host that answers
   `200` without redirects (strict UTF-8, ≤128 MiB). Users add that URL under
   **Plugins → Discover → Add index source**, then install the plugin.

The index is unsigned: the install confirmation shows the index URL and the
exact source spec, so the URL you publish is your identity.

## Live artifacts

| Thing | Value |
|---|---|
| Repository (public) | `https://github.com/324641aliyun/dsh-full-permission-real` |
| Live market index | `https://raw.githubusercontent.com/324641aliyun/dsh-full-permission-real/main/market/index.json` |
| Install source | commit-pinned `git+https://github.com/324641aliyun/dsh-full-permission-real.git#<commit>` |
| npm variant | `market/index.npm-sample.json` (activates once npm publishing is possible) |
| Validate | `node market/validate.mjs` |
| Local preview | `node market/serve.mjs 8791` → `http://127.0.0.1:8791/index.json` |

## Publish a new version (Git path — currently used)

1. Bump `version` in `package.json`, add a `CHANGELOG.md` entry, and extend the
   plugin's `versions` array in `market/index.json` (newest first, Unix-seconds
   `publishTimestamp`).
2. `node market/validate.mjs` and the test suite must pass.
3. Commit and push to `main`. The index must point at a commit whose tree
   contains this package:
   ```powershell
   git add -A
   git commit -m "Release dsh-full-permission-real <version>"
   git push origin main
   $commit = git rev-parse HEAD
   # put $commit into market/index.json's versions[0].source.commit,
   # then commit and push again; the index may reference the previous commit.
   ```
4. Verify the hosted index and the exact install spec:
   ```powershell
   Invoke-WebRequest -Uri "https://raw.githubusercontent.com/324641aliyun/dsh-full-permission-real/main/market/index.json" -MaximumRedirection 0 -UseBasicParsing
   ```
5. Install it the way Discover does:
   `plugin_manager` `install_bundle(target: "git+https://github.com/324641aliyun/dsh-full-permission-real.git#<commit>")`.

## npm publishing (optional, requires bypass-2FA token)

The npm account currently uses `auth-and-writes` 2FA with a passkey, and npm CLI
publishing needs either an OTP or a granular token with **Bypass 2FA** enabled.
When such a token exists:

```powershell
cd "C:\Users\324641\Documents\Temporary workspace\dsh-full-permission-real"
$env:NODE_AUTH_TOKEN = '<granular token with Bypass 2FA>'
cmd /c "npm publish --access public"
```

Then switch `market/index.json` to the npm source shown in
`market/index.npm-sample.json` (or keep both: a version may list any source
form). `tools/publish.ps1` automates the npm-publish + git-push sequence once
the token works; it validates before touching anything.

## Point users' DSH at the index

**Plugins → Discover → Add index source** and paste the live index URL, or add it
to the profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: plugin-market
  config:
    indexes:
      - https://raw.githubusercontent.com/324641aliyun/dsh-full-permission-real/main/market/index.json
```

Then **Discover → Full permission (real) → Install**. Installation runs
`pnpm add git+https://...#<commit>` in the profile and activates the bundle
patch; no manual profile edit is required.

## Local verification (no account needed)

```powershell
node market/serve.mjs 8791
# Plugins -> Discover -> Add index source: http://127.0.0.1:8791/index.json
```

The local index is display-identical to the published one; the Git install target
already works because the repository is public.

## Version bumps

1. Bump `version`, changelog, and `market/index.json` versions array.
2. `node market/validate.mjs && npm test` (or the individual `test:*` scripts).
3. Commit, push, then pin the new commit in `market/index.json`, commit, push.
4. Install the new commit to verify, then report the version.
