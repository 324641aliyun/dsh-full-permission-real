# Publishing to the DSH plugin market

DSH has **no central marketplace and ships no index source**. "Publishing" means
two independent things:

1. **Making the bundle installable** — publish the package to npm
   (`dsh-full-permission-real@1.0.0`) **or** push the Git repository and pin a
   commit. `npm` is the recommended target; it is what `market/index.json`
   already describes.
2. **Hosting a format-1 index JSON** on any static `http(s)` host that answers
   `200` without redirects (strict UTF-8, ≤128 MiB). Users add that URL under
   **Plugins → Discover → Add index source**, then install the plugin. The
   recommended host is the repository's own `raw.githubusercontent.com` URL for
   `market/index.json`.

The index is unsigned: the install confirmation shows the index URL and the
exact source spec, so the URL you publish is your identity.

## What is already in this repository

| File | Purpose |
|---|---|
| `market/index.json` | Format-1 index, npm install target `dsh-full-permission-real@1.0.0`. |
| `market/index.git-sample.json` | Same plugin as a commit-pinned Git target (replace the placeholder commit after the first push). |
| `market/icons/dsh-full-permission-real.svg` | Index icon referenced relatively by the index. |
| `market/serve.mjs` | Local static server used for loopback Discover verification. |
| `market/validate.mjs` | Runs the real DSH validator + a Discover simulation against this folder. |
| `tools/publish.ps1` | Guided publish script (npm first, then Git). |

## Prerequisites (the user must authorize these)

- An npm account with publish rights, logged in on this machine:
  `cmd /c npm login` (interactive; 2FA is prompted by npm itself).
- A **public** GitHub repository named `dsh-full-permission-real` under the
  account that will own the index (the generated artifacts assume
  `324641aliyun`). Do not initialize it with files.
- Git credentials that can push to that repository.

## Publish

```powershell
cd "C:\Users\324641\Documents\Temporary workspace\dsh-full-permission-real"

# 1. re-validate everything against the local DSH installation
node market/validate.mjs

# 2. npm + git publish (this script checks its prerequisites and stops early)
powershell -ExecutionPolicy Bypass -File tools\publish.ps1 -Owner 324641aliyun
```

The script performs, in order:

1. `cmd /c npm whoami` (fails with ENEEDAUTH before touching anything).
2. `cmd /c npm publish --access public` from the repository root.
3. `git init` (idempotent), identity check, `git add -A`, commit.
4. `git remote add origin https://github.com/<owner>/dsh-full-permission-real.git`
   (or reuse `.git/config`'s existing `origin`), `git push -u origin main`.
5. Prints the npm package URL, the index URL, and the pushed commit SHA.

After that, replace the npm entry's placeholder expectations:

- The published index URL becomes
  `https://raw.githubusercontent.com/<owner>/dsh-full-permission-real/main/market/index.json`.
- If you prefer the Git install target, put the printed commit SHA into
  `market/index.git-sample.json`, commit, and push.
- Run `node market/validate.mjs` again after changing the owner or the commit;
  it validates the index against the real DSH validator and simulates Discover.

## Point users' DSH at the index

**Plugins → Discover → Add index source** and paste the index URL, or add it to
the profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: plugin-market
  config:
    indexes:
      - https://raw.githubusercontent.com/<owner>/dsh-full-permission-real/main/market/index.json
```

Then **Discover → Full permission (real) → Install**. The install runs
`pnpm add dsh-full-permission-real@1.0.0` in the profile and activates the
bundle patch; no manual profile edit is required.

**Alternative without an npm account:** use the Git index
(`market/index.git-sample.json`) and let DSH install
`git+https://github.com/<owner>/dsh-full-permission-real.git#<commit>`. The
repository still has to be public.

## Local verification (no account needed)

```powershell
node market/serve.mjs 8791
# Plugins -> Discover -> Add index source: http://127.0.0.1:8791/index.json
```

Discover can load and display the entry; **installing from the local index only
works after npm publish** (its install target is the npm package). To install the
unpublished build for testing use the local path install instead:

```powershell
# through the agent: plugin_manager install_bundle(target: <absolute path>)
dsh plugin --profile web add "C:\Users\324641\Documents\Temporary workspace\dsh-full-permission-real"
```

## Version bumps

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Add a new object to the plugin's `versions` array in `market/index.json`
   (newest first, with its `publishTimestamp` in Unix seconds) and set
   `engines.dsh` to the package manifest's value.
3. `node market/validate.mjs`, then re-run `tools/publish.ps1`.
