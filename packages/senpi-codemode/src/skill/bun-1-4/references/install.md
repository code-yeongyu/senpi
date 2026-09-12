# bun install & package management in 1.4

## Global virtual store: up to 7x faster installs [v1.3.14]

Blog: [#global-virtual-store-up-to-7x-faster-installs](https://bun.com/blog/bun-v1.4#global-virtual-store-up-to-7x-faster-installs)

```toml
# bunfig.toml
[install]
linker = "isolated"
```

With the isolated linker, packages extract once into Bun's global cache and are symlinked into `node_modules/.bun/` (one `symlink()` per package instead of one `clonefileat()`). Warm-cache CI installs of 1,400 packages: 7x faster. Opt-in for existing projects; **new monorepos default to isolated** (see below).

## New subcommands [v1.4.0]

Blog anchors: [#bun-pm-diff](https://bun.com/blog/bun-v1.4#bun-pm-diff), [#bun-audit-fix](https://bun.com/blog/bun-v1.4#bun-audit-fix), [#bun-dedupe](https://bun.com/blog/bun-v1.4#bun-dedupe), [#bun-prune](https://bun.com/blog/bun-v1.4#bun-prune), [#bun-pm-licenses](https://bun.com/blog/bun-v1.4#bun-pm-licenses)

```bash
bun pm diff react                    # lockfile version → latest; un-minifies before diffing;
bun pm diff react@18.2.0 19.0.0      # summary flags new install scripts + new child_process/fs/net/vm imports
bun pm diff ./vendored-pkg pkg@2.1.0

bun audit fix                        # upgrade vulnerable packages to safe versions; --latest allows majors; --dry-run
bun dedupe                           # collapse duplicate versions in bun.lock; --check fails CI on dupes
bun prune --production               # delete node_modules entries not in bun.lock; --production drops devDeps
bun pm licenses --prod --json        # dependency license inventory
```

Docker pattern: build with devDeps, ship without:

```dockerfile
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build
RUN bun prune --production
```

## bun update: transitive + patterns [v1.4.0]

Blog: [#bun-update-updates-transitive-dependencies](https://bun.com/blog/bun-v1.4#bun-update-updates-transitive-dependencies)

```bash
bun update                    # now updates deps-of-deps too
bun update zod                # updates zod everywhere it appears
bun update '@types/*' --latest
```

`bun update <name>` errors (exit 1) if nothing depends on it (no longer silently adds).

## Monorepo: --filter and --catalog [v1.4.0]

Blog: [#bun-add-filter](https://bun.com/blog/bun-v1.4#bun-add-filter), [#bun-add-catalog](https://bun.com/blog/bun-v1.4#bun-add-catalog)

```bash
bun add zod --filter api          # add to one workspace from the repo root
bun run --filter 'web...' build   # web + its dependencies; '...web' = its dependents
bun add react --catalog           # add to root catalog, write "catalog:" in the workspace
```

Plain `bun add x` in a workspace whose default catalog lists `x` writes `catalog:` automatically.

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

npm nested form, yarn `a/b`, pnpm `a>b` all work; overrides can be version-scoped. Lockfiles using these become `lockfileVersion: 3` (older Bun can't read them).

## Supply-chain hardening

- **Lockfile integrity** [v1.3.10]: `bun.lock` records SHA-512 for GitHub and tarball deps, like npm packages.
- **`trustedDependencies` auto-trust is npm-registry-only** [v1.3.5]: a `git:`/`github:`/`file:` package named `esbuild` gets NO trust from the default list — list it yourself. Names match exactly (not by hash).
- **`nativeDependencies`** [v1.3.2]: for packages shipping prebuilt binaries as per-platform optionalDependencies, Bun links the right binary directly instead of running postinstall. **`ignoreScripts`** skips a package's lifecycle scripts even if trusted.

```json
{ "nativeDependencies": ["esbuild"], "ignoreScripts": ["sharp"] }
```

## Defaults changed in 1.4 (see also breaking-changes.md)

- New monorepos default to `linker: "isolated"` (`configVersion: 1` in bun.lock). Existing lockfiles keep hoisted. Pin `linker = "hoisted"` to opt out.
- `bun.lock` is `lockfileVersion: 2`: out-of-registry tarballs need integrity hashes; git entries validated against path traversal. Run `bun install` to migrate.
- A project's `bunfig.toml` now overrides `.npmrc` for the same key.
- `bun init` writes `typescript ^7`; non-TTY `bun init` behaves as `-y`.
