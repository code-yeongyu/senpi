# Conformance candidate archive

From the repository root, with Bun 1.4+, Node and npm installed:

```sh
bun packages/agent/scripts/pack-conformance-archive.ts <commit> /absolute/output.tar.gz
```

The producer resolves a full commit SHA, materializes that commit with `git archive`,
installs its frozen dependencies, builds the agent and its prerequisites, and packs
the agent with lifecycle scripts disabled. A dirty checkout or an existing `dist`
directory cannot contribute to the artifact. Build staging is removed on success
and failure; `TMPDIR` controls its location.

The resulting gzip tar contains:

- `package.tgz`: the complete packed agent package, including its `./conformance` export;
- original TypeScript implementation files at the paths named by that export's registry;
- `manifest.json`: `{ senpiSha, files: [{ path, sha256 }], packageTarballSha256 }`.

Files are ordered by registry path. Hashes use the original source bytes. Before
publishing the archive, the producer loads the export unpacked from `package.tgz`
and checks its reconstructed manifest against the same commit's source manifest,
using the existing CONF.bun hash contract. The final JSON line reports the commit,
suite hash, case count and archive SHA-256.

External hosts verify every manifest digest before importing the packed export.
They pass the archived source bytes to `buildManifest`, execute that export's case
maps, and compare their complete passing case sets and suite hashes with CONF.bun
at `senpiSha`. The archive is a conformance artifact, not a new runtime package or
a release.
