# Codex app-server protocol

This directory vendors the TypeScript protocol fixture from Codex git commit
`0fb559f0f6e231a88ac02ea002d3ecd248e2b515` (author date 2026-07-18).

Generated source:

```bash
packages/coding-agent/scripts/generate-app-server-protocol.sh \
  --from-checkout /Users/yeongyu/local-workspaces/codex
```

Checkout mode recursively copies this Codex-maintained fixture verbatim, deletes
files no longer present upstream, preserves only the local `generated/package.json`
compilation shim, and derives `PROTOCOL_VERSION.txt` from the checkout's HEAD SHA
and author date:

```text
/Users/yeongyu/local-workspaces/codex/codex-rs/app-server-protocol/schema/typescript
```

Do not hand-edit files under `generated/`. Update them with
`packages/coding-agent/scripts/generate-app-server-protocol.sh` when the pinned
Codex protocol version changes.

The generated `.ts` files intentionally remain byte-for-byte identical to the
research artifact. The extra `generated/package.json` file is a local build shim
and is not part of upstream payload identity. The generated TypeScript is raw
upstream protocol evidence, not app-facing build input: `ts-rs` generated
extensionless sibling imports are incompatible with this package's
Node16/NodeNext ESM compilation strategy. The package build excludes
`generated/**/*.ts`, and root typechecking only tolerates the raw tree because
the shim marks that subtree as CommonJS without changing any generated
TypeScript bytes. Keep app-facing protocol imports out of `generated/**`; use
the non-generated facade instead.

## Handwritten facade policy

The non-generated facade is the app-server build and runtime contract. It is
handwritten from the pinned Codex source and generated evidence, then exposed
through `index.ts`. Runtime modules must import protocol types from that facade;
the raw generated tree must never become a runtime dependency. Direct generated
imports are restricted to isolated type-evidence and compatibility checks while
the corresponding facade surface is being filled in.

The generated TypeScript tree is not a complete inventory of Codex runtime
methods. Codex's exporter intentionally omits experimental request roots, even
when `common.rs` still declares and serves those methods. Supplemental facade
modules therefore cover the experimental request families selected by the
parity plan, using the pinned `common.rs` method fixture as provenance instead
of treating exporter absence as runtime removal.

The facade also records these deliberate projections:

- `SENPI_COLLABORATION_MODE` is the single generated-schema-valid
  `CollaborationMode` projection used by Senpi. Its nested
  `reasoning_effort` member remains snake_case because that is the Codex wire
  contract.
- Fuzzy-file results use the pinned Codex HEAD `match_type` and `file_name`
  members. This common-protocol record intentionally remains snake_case even
  though most v2 request and response members are camelCase.
- Account usage and rate-limit counters that are bigint-like in Codex source
  are normalized to JSON-safe `number` values in the facade. JavaScript
  `bigint` cannot be serialized in an app-server JSON frame.
