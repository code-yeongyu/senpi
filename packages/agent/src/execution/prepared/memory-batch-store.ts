import { createMemoryStoreMedium, openMemoryStore } from "../../durable/store-memory.ts";
import type { BatchStoreFactory } from "../../types.ts";

/** A batch ledger that lives only in this process for the batch's duration: the in-process (fused) placement. */
export const openMemoryBatchStore: BatchStoreFactory = () => openMemoryStore(createMemoryStoreMedium());
