import { FRAGMENT_MAX_BYTES } from "./compact-recovery-bytes.ts";
import { protocolId } from "./compact-recovery-ids.ts";
import type { StagedContent, TransferStaging } from "./compact-transfer-staging.ts";
import { jsonChunks } from "./json-pieces.ts";

export type RecordContent = string | { readonly units: number } | { readonly chunks: () => Iterable<string> };

/** Ordinary records and host snapshots share the bounded fragment/staging substrate. */
export function stageRecord(staging: TransferStaging, record: object, content: RecordContent): StagedContent {
	const kind = protocolId("event");
	const id = protocolId("record");
	if (typeof content === "string") return staging.stage(kind, id, content.slice(0, -1));
	const chunks = "chunks" in content ? content.chunks : () => jsonChunks(record, FRAGMENT_MAX_BYTES / 2);
	let units = "units" in content ? content.units : 0;
	if ("chunks" in content) for (const chunk of chunks()) units += chunk.length;
	const transfer = staging.begin(kind, id, units * 2);
	try {
		for (const chunk of chunks()) transfer.append(chunk);
		return transfer.commit();
	} catch (cause) {
		transfer.abort();
		throw cause;
	}
}
