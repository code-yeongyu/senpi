# bun install & package management in 1.4.x

## Session rules first — each one cost a past session hours

- **Unattended installs block on prompts.** A repo's `prepare` script can ask a question (desktop's `vp config` git-hook prompt sat at 0% CPU for 14 min); run installs with `CI=1`, stdin closed, visible output in a background bash session — never `bun install | tail` (2026-10-15/19/20). If a process shows 0 CPU and no network while the package set stopped changing, it is prompting or wedged: inspect the child, do not start tests.
- **`--ignore-scripts` leaves `node_modules/bun` as a placeholder.** When a repo pins `bun` as a devDependency, the npm `bun` package's bin is a stub until its postinstall runs; with `node_modules/.bin` first on PATH every `bun …` script then fails ("Bun's postinstall script was not run", ENOEXEC). Run `(cd node_modules/bun && node install.js)` after an `--ignore-scripts` install, or keep the system `bun` ahead on PATH (2026-10-06, 10-26, 10-31). Never `bun add bun` anywhere: it installs that placeholder over the real runtime; upgrade with `bun upgrade`.
- **Global installs stay task-local.** A global npm/bun install can replace `~/.bun/bin/bun` with a broken shim and a stray `bun` in `~/.bun/install/global/node_modules/.bin` shadows the real one on PATH. Use `BUN_INSTALL=$RUN_TMP/bun-global` for globals a task needs (2026-10-10, 10-22).
- **`bun add` with no package.json in cwd edits the nearest ancestor** — it once rewrote `~/package.json` + `~/bun.lock` (2026-10-27). Check `pwd` first.
- **Evidence runs use the repo's pinned Bun**, not the machine's newest: the pin lives in CI (`bun-version:`) and often `package.json` `devDependencies.bun`; 1.4.2 vs 1.4.3 differed in test behaviour, and two jobs swapping a box-wide pin corrupted each other's evidence (2026-10-16/18).
- **`--frozen-lockfile` refuses only missing packages**; it does not prove `node_modules` matches, and a post-rebase `bun install` can rewrite `bun.lock` with incidental range churn — diff the lockfile before committing (2026-09-21, 10-05, 10-26). `~/.bun/install/cache` is shared by every project: never delete it for disk space; `bun pm cache prune --max-age 7` is the tool.
- **Symlinked `node_modules` from another checkout is stale and mutable**: package scripts rewrite files in place, so every concurrent run gets its own install (2026-09-30). Concurrent installs in worktrees that share one `.git` contend on its lock — stagger them (2026-10-19).

## Global virtual store: up to 7x faster installs [v1.3.14]

Blog: [#global-virtual-store-up-to-7x-faster-installs](https://bun.com/blog/bun-v1.4#global-virtual-store-up-to-7x-faster-installs)

```toml
# bunfig.toml
[install]
linker = "isolated"
```

With the isolated linker, packages extract once into Bun's global cache and are symlinked into `node_modules/.bun/` (one `symlink()` per package instead of one `clonefileat()`). Warm-cache CI installs of 1,400 packages: 7x faster. Opt-in for existing projects; **new monorepos default to isolated** (see below).

## Offline, cached and CI installs [v1.4.1, v1.4.4]

Blog: [1.4.1 #bun-install-offline](https://bun.com/blog/bun-v1.4.1), [1.4.4 #bun-pm-fetch](https://bun.com/blog/bun-v1.4.4)

```bash
bun install --prefer-offline          # use cached manifests regardless of age; fetch only what is missing — fast fresh worktrees
bun install --offline                 # no network at all; a missing package is a named error
bun pm fetch                          # download every dependency into the cache; no node_modules, no scripts, lockfile untouched
bun pm cache pack .ci/bun-cache.pack  # after an install: one file with the cache entries the lockfile needs
bun pm cache unpack .ci/bun-cache.pack && bun install --frozen-lockfile   # on another runner
bun pm cache prune --max-age 7        # drop old cache entries (--dry-run lists)
BUN_CONFIG_HTTP_RETRY_BACKOFF=250 bun install   # registry retries 250 ms → 4 s (default 50 ms → 800 ms, ±20% jitter, Retry-After honoured) [v1.4.4]
```

Docker: keep downloads in a layer that only changes with the lockfile, build with devDeps, ship without:

```dockerfile
COPY package.json bun.lock ./
RUN bun pm fetch
COPY . .
RUN bun install --offline --frozen-lockfile
RUN bun run build && bun prune --production
```

`bunfig.toml`: `[install] offline = true` / `prefer = "offline"`. Linux installs skip the native build for the other libc (`--libc musl` for an Alpine image built elsewhere, `--libc '*'` for both) [v1.4.4].

## Diagnose and fix the tree [v1.4.0, v1.4.4]

Blog anchors: [#bun-pm-diff](https://bun.com/blog/bun-v1.4#bun-pm-diff), [#bun-audit-fix](https://bun.com/blog/bun-v1.4#bun-audit-fix), [#bun-dedupe](https://bun.com/blog/bun-v1.4#bun-dedupe), [#bun-prune](https://bun.com/blog/bun-v1.4#bun-prune), [#bun-pm-licenses](https://bun.com/blog/bun-v1.4#bun-pm-licenses)

```bash
bun why lodash                       # which dependents pull a package in (deduped tree); bun pm ls lodash lists installed copies
bun pm diff react                    # lockfile version → latest; un-minifies before diffing;
bun pm diff react@18.2.0 19.0.0      # summary flags new install scripts + new child_process/fs/net/vm imports
bun outdated                         # what bun update would change; bun update --depth 0 touches only package.json deps [v1.4.4]
bun audit fix                        # upgrade vulnerable packages to safe versions; --latest allows majors; --dry-run
bun pm scan                          # security-scanner pass over the whole lockfile
bun dedupe                           # collapse duplicate versions in bun.lock; --check fails CI on dupes
bun prune --production               # delete node_modules entries not in bun.lock; --check only reports (exit 1 if anything) [v1.4.4]
bun pm licenses --prod --json        # dependency license inventory
bun patch pkg && bun patch --commit pkg   # edit a dependency in place; never hand-edit the .patch (2026-09-11)
```

`bun install` warns about deprecated packages and prefers non-deprecated versions when resolving a range [v1.4.4].

## bun update: transitive + patterns [v1.4.0]

Blog: [#bun-update-updates-transitive-dependencies](https://bun.com/blog/bun-v1.4#bun-update-updates-transitive-dependencies)

```bash
bun update                    # now updates deps-of-deps too
bun update zod                # updates zod everywhere it appears
bun update '@types/*' --latest
```

`bun update <name>` errors (exit 1) if nothing depends on it (no longer silently adds). `bun add --dev x` moves an existing dependency between groups instead of leaving it [v1.4.4].

## Monorepo: --filter and --catalog [v1.4.0]

Blog: [#bun-add-filter](https://bun.com/blog/bun-v1.4#bun-add-filter), [#bun-add-catalog](https://bun.com/blog/bun-v1.4#bun-add-catalog)

```bash
bun add zod --filter api          # add to one workspace from the repo root
bun run --filter 'web...' build   # web + its dependencies; '...web' = its dependents
bun add react --catalog           # add to root catalog, write "catalog:" in the workspace
```

Plain `bun add x` in a workspace whose default catalog lists `x` writes `catalog:` automatically. `--filter '{packages}'` selects every workspace under a directory; `bun publish --recursive --filter "@acme/*"` publishes a monorepo in dependency order, skipping private and already-published versions [v1.4.4].

- `"workspaces": { "packages": [...], "selfContained": ["apps/desktop"] }` gives a workspace its own full `node_modules` (Electron and other layout-sensitive tools) [v1.4.1].
- `"packageExtensions": { "legacy-plugin@2": { "dependencies": { "lodash": "^4" } } }` adds a dependency a package forgot to declare — the isolated linker needs it [v1.4.4].
- `"dep": "link:./vendor/dep"` symlinks a directory without `bun link` [v1.4.4]; `file:` folder deps are installed as hardlinks in 1.4.4 (per-file symlinks in 1.4.3), which changes what "no links in node_modules" checks see (senpi#4223).
- With the isolated linker, a root-level non-workspace directory (`scripts/`) cannot import `@scope/pkg`; make it a workspace package (2026-10-02).

## Nested overrides [v1.4.0]

Blog: [#nested-overrides](https://bun.com/blog/bun-v1.4#nested-overrides)

```json
{
  "overrides": {
    "express": { "qs": "6.13.0" },
    "lodash@<4.17.21": "4.17.21"
  }
}
```

npm nested form, yarn `a/b`, pnpm `a>b` all work; overrides can be version-scoped. Lockfiles using these become `lockfileVersion: 3` (older Bun can't read them). Overrides are NOT applied to an `npm:` alias spec (2026-10-02). Peer dependencies resolve like pnpm since 1.4.4: a peer nobody provides gets a version inside its range instead of whatever another package installed.

## Supply-chain hardening

- **Lockfile integrity** [v1.3.10]: `bun.lock` records SHA-512 for GitHub and tarball deps, like npm packages.
- **`trustedDependencies` auto-trust is npm-registry-only** [v1.3.5]: a `git:`/`github:`/`file:` package named `esbuild` gets NO trust from the default list — list it yourself. Names match exactly (not by hash).
- **`nativeDependencies`** [v1.3.2]: for packages shipping prebuilt binaries as per-platform optionalDependencies, Bun links the right binary directly instead of running postinstall. **`ignoreScripts`** skips a package's lifecycle scripts even if trusted.

```json
{ "nativeDependencies": ["esbuild"], "ignoreScripts": ["sharp"] }
```

## Flags, env and bunx [v1.4.4]

- `bun install` translates npm/Yarn/pnpm flags (`--immutable`, `--save-dev`, `--node-linker=isolated` …) and **rejects unknown flags** — `--frozen-lockfil` used to run a plain install silently in CI.
- `bun install --env-file ci.env`, `bunx --env-file ci.env prisma migrate deploy`, `bunx --cwd packages/api <tool>`, `bunx -p pkg cmd` (pkg's bins first on PATH), `bunx --trust` (run the tool's lifecycle scripts).
- `[install] minimumReleaseAge = "3d"` with `minimumReleaseAgeExcludes = ["typescript@5.9.3"]` delays fresh releases except a named one.
- `NPM_CONFIG_USERCONFIG` from `actions/setup-node` is read, so private registries work in CI without copying `.npmrc`.

## Defaults changed in 1.4.x (see also breaking-changes.md)

- New monorepos default to `linker: "isolated"` (`configVersion: 1` in bun.lock). Existing lockfiles keep hoisted. Pin `linker = "hoisted"` to opt out.
- `bun.lock` is `lockfileVersion: 2`: out-of-registry tarballs need integrity hashes; git entries validated against path traversal. Run `bun install` to migrate. 1.4.4 adds `hasInstallScript` and `libc` keys that older Bun drops on its next save.
- A project's `bunfig.toml` now overrides `.npmrc` for the same key.
- `bun init` writes `typescript ^7`; non-TTY `bun init` behaves as `-y`.
- Yarn Berry lockfiles migrate all-or-nothing [v1.4.4]; `bun pm migrate` on a 20k-entry Yarn v1 lock takes 0.27 s.
