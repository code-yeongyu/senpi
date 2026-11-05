# @code-yeongyu/senpi-storage-sqlite-bun

The Bun SQLite backend of senpi's durable store. It implements the durable core's `DurableStore` contract and its synchronous
`SyncCommitStore` capability on `bun:sqlite`, one store file per medium (WAL, `synchronous=FULL`, every mutation one
`BEGIN IMMEDIATE` transaction). senpi uses it as the default session store when it runs on Bun or as the compiled binary.

It requires Bun (`bun:sqlite`); it is never loaded on Node. It ships as TypeScript source, which Bun runs directly.

```ts
import { createBunSqliteMedia } from "@code-yeongyu/senpi-storage-sqlite-bun";

const media = createBunSqliteMedia("/path/to/store-root");
const store = await media.open(await media.createMedium());
await store.claim(0, 1);
```

The contract (claim, commit, records, documents, snapshots) and its conformance suite live in `@code-yeongyu/senpi-agent-core`.
