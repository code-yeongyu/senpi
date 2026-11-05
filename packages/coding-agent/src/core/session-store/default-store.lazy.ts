// The durable default store imports bun:sqlite, which Node cannot load: it is reached only through this boundary, and
// only on Bun, so nothing in the CLI's static import graph pulls it in.
export const loadDefaultSessionStore = () => import("./default-store.ts");
