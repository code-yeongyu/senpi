# @earendil-works/pi-storage-sqlite-node

Node sqlite storage backend for `@earendil-works/pi-agent-core` sessions. Provides the
`node:sqlite` adapter (`SqliteDatabase` implementation) and the SQLite session
store implementation (`createSqliteSessionStore`, migrations, materialized views). The store
lazily owns one shared database connection and implements `AsyncDisposable`.

```ts
await using store = createSqliteSessionStore(options);
const search = createSqliteSessionSearch(options);
const repository = createSessionRepository({ store, search });
```
