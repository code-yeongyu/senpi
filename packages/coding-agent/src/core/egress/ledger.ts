/**
 * The brain's `egress_call` ledger (row CK9; custody design 4.5). Every write is one admitted mutation supplied by the
 * host wrapper, which fences it (epoch, admission seq, instance generation) and commits it atomically; the ledger only
 * builds the writes. W4 (row + request chunks) precedes any dial, W4' (`hooked`) replaces the request and sets
 * `hooksApplied` in one mutation, `ended` (row + the assembled message in result chunks) is durable before the terminal
 * event, and the step commit (W9) closes the row and deletes its chunks with `closeCallWrites` inside its own mutation.
 * A cancelled step (W14) is never dialed again, so W14 deletes the live row's chunks too: nothing else would.
 */
import type { DeviceId, ProviderId } from "@earendil-works/pi-agent-core";
import type { DurableStore, StoreWrite } from "@earendil-works/pi-agent-core/conformance";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	callKey,
	cancelledKey,
	decodeCallRow,
	decodeVariant,
	type EgressCallEnd,
	type EgressCallRow,
	encodeCallRow,
	encodeVariant,
	isStoredMessage,
	requestChunkKey,
	resultChunkKey,
	splitUtf8,
	stepIndexKey,
	stepIndexPrefix,
	type VariantRecord,
	variantKey,
	variantPrefix,
} from "./ledger-schema.ts";

/** Runs `build` inside the host's admission slot and commits the writes it returns as one fenced, atomic mutation. */
export type AdmittedMutation = (build: () => Promise<readonly StoreWrite[]>) => Promise<void>;
export type NewCallRow = Omit<EgressCallRow, "state" | "requestChunks" | "result">;

export interface VariantMismatch {
	readonly providerId: ProviderId;
	readonly deviceId: DeviceId;
	readonly stepId: string;
	readonly headDigest: string;
	readonly liveAtMismatch: string | undefined;
}

export interface EgressLedger {
	/** Every row of the step, oldest attempt first. */
	rowsForStep(stepId: string): Promise<EgressCallRow[]>;
	/** The stored request text, byte-identical to what was admitted (or what `hooked` replaced it with). */
	readRequest(row: EgressCallRow): Promise<string>;
	/** The assembled message of an `ended` row whose result is a message. */
	readMessage(row: EgressCallRow): Promise<AssistantMessage>;
	/** W4. With `previous`, the previous row is retired (`ended` -> `closed`) and its request chunks deleted, atomically. */
	dispatch(next: NewCallRow, requestJson: string, previous?: EgressCallRow): Promise<EgressCallRow>;
	/** W4': the post-hook request replaces the stored one and `hooksApplied` becomes true, in one mutation. */
	recordHooked(row: EgressCallRow, requestJson: string): Promise<EgressCallRow>;
	end(row: EgressCallRow, result: EgressCallEnd): Promise<EgressCallRow>;
	/**
	 * The hand refused `row`'s start, so nothing ran: the row and its chunks are replaced by the same call under a new
	 * `callId` (same attempt, same stored request) in one mutation. A duplicate `start{callId}` is a result query (4.3),
	 * so the refused callId can never be started again.
	 */
	replaceRefused(row: EgressCallRow, callId: string): Promise<EgressCallRow>;
	/** The row is superseded; a definition mismatch records the device variant in the same mutation. */
	supersede(row: EgressCallRow, variant?: VariantMismatch): Promise<EgressCallRow>;
	/** W14: the step is cancelled (and its live row with it); a cancelled step is never dialed again. */
	cancelStep(stepId: string, row: EgressCallRow | undefined): Promise<void>;
	isCancelled(stepId: string): Promise<boolean>;
	recordVariant(variant: VariantMismatch): Promise<void>;
	variants(providerId: ProviderId): Promise<ReadonlyMap<DeviceId, VariantRecord>>;
}

const putRow = (row: EgressCallRow): StoreWrite => ({ op: "put", key: callKey(row.callId), data: encodeCallRow(row) });

const deletes = (count: number, key: (index: number) => string): StoreWrite[] =>
	Array.from({ length: count }, (_, index) => ({ op: "delete", key: key(index) }));

/** Every stored chunk of `row`: its request and, once `ended` with a message, the assembled message. */
const chunkDeletes = (row: EgressCallRow): StoreWrite[] => [
	...deletes(row.requestChunks, (index) => requestChunkKey(row.callId, index)),
	...deletes(row.result?.kind === "message" ? row.result.chunks : 0, (index) => resultChunkKey(row.callId, index)),
];

/** A cancelled row keeps its identity and an error result, never pointers to chunks W14 deleted. */
function cancelledRow(row: EgressCallRow): EgressCallRow {
	const { result, ...fields } = row;
	return { ...fields, state: "cancelled", requestChunks: 0, ...(result?.kind === "error" ? { result } : {}) };
}

/**
 * W14 on the step's live row. A dispatched or ended row becomes `cancelled`; a superseded row (the abort came while its
 * reissue waited: the pacer backoff or the user's choice) stays superseded. Either way its chunks are deleted, because a
 * cancelled step is never dialed again, so no later W4 retires them.
 */
function cancelWrites(row: EgressCallRow): StoreWrite[] {
	if (row.state === "closed" || row.state === "cancelled") return [];
	const kept = row.state === "superseded" ? { ...row, requestChunks: 0 } : cancelledRow(row);
	return [putRow(kept), ...chunkDeletes(row)];
}

/** The W9 part the ledger owns: the step's row becomes `closed` and its request chunks are deleted (4.5 retention). */
export function closeCallWrites(row: EgressCallRow): StoreWrite[] {
	return [putRow({ ...row, state: "closed" }), ...chunkDeletes(row)];
}

export function createEgressLedger(options: {
	readonly store: Pick<DurableStore, "getDocument" | "scanDocuments">;
	readonly mutate: AdmittedMutation;
}): EgressLedger {
	const { store, mutate } = options;
	const withRequest = (row: EgressCallRow, requestJson: string): { row: EgressCallRow; writes: StoreWrite[] } => {
		const chunks = splitUtf8(requestJson);
		const next = { ...row, requestChunks: chunks.length };
		const writes: StoreWrite[] = chunks.map((data, index) => ({
			op: "put",
			key: requestChunkKey(row.callId, index),
			data,
		}));
		return { row: next, writes: [...writes, putRow(next)] };
	};
	const variantWrite = async (variant: VariantMismatch): Promise<StoreWrite> => {
		const key = variantKey(variant.providerId, variant.deviceId);
		const prior = decodeVariant(await store.getDocument(key));
		const sameRun = prior !== undefined && prior.headDigest === variant.headDigest && prior.stepId === variant.stepId;
		const mismatches = sameRun ? prior.mismatches + 1 : 1;
		const { headDigest, liveAtMismatch, stepId } = variant;
		return { op: "put", key, data: encodeVariant({ headDigest, liveAtMismatch, mismatches, stepId }) };
	};
	const stepOf = (row: NewCallRow): { readonly stepId: string; readonly attempt: number } => {
		if (row.call.kind !== "step") throw new Error("the device-route ledger indexes loop steps only");
		return row.call;
	};
	const readRow = async (callId: string): Promise<EgressCallRow | undefined> =>
		decodeCallRow(await store.getDocument(callKey(callId)));
	const readChunks = async (row: EgressCallRow, what: string, count: number, key: (index: number) => string) => {
		const chunks = await Promise.all(Array.from({ length: count }, (_, index) => store.getDocument(key(index))));
		if (!chunks.every((chunk): chunk is string => typeof chunk === "string"))
			throw new Error(`egress_call ${row.callId}: stored ${what} is incomplete`);
		return chunks.join("");
	};

	return {
		async rowsForStep(stepId) {
			const index = await store.scanDocuments(stepIndexPrefix(stepId));
			const rows = await Promise.all(
				index.map((entry) => (typeof entry.data === "string" ? readRow(entry.data) : undefined)),
			);
			return rows.filter((row): row is EgressCallRow => row !== undefined);
		},
		readRequest: (row) =>
			readChunks(row, "request", row.requestChunks, (index) => requestChunkKey(row.callId, index)),
		async readMessage(row) {
			if (row.result?.kind !== "message") throw new Error(`egress_call ${row.callId} has no stored message`);
			const key = (index: number) => resultChunkKey(row.callId, index);
			const parsed: unknown = JSON.parse(await readChunks(row, "message", row.result.chunks, key));
			if (!isStoredMessage(parsed)) throw new Error(`egress_call ${row.callId}: stored message is malformed`);
			return parsed;
		},
		async dispatch(next, requestJson, previous) {
			const { stepId, attempt } = stepOf(next);
			const created = withRequest({ ...next, state: "dispatched", requestChunks: 0 }, requestJson);
			const retire = previous
				? [
						putRow({ ...previous, state: previous.state === "ended" ? "closed" : previous.state }),
						...chunkDeletes(previous),
					]
				: [];
			const index: StoreWrite = { op: "put", key: stepIndexKey(stepId, attempt), data: next.callId };
			await mutate(async () => [...retire, ...created.writes, index]);
			return created.row;
		},
		async recordHooked(row, requestJson) {
			const updated = withRequest({ ...row, hooksApplied: true }, requestJson);
			await mutate(async () => [...chunkDeletes(row), ...updated.writes]);
			return updated.row;
		},
		async end(row, result) {
			if (result.kind === "error") {
				const failed: EgressCallRow = { ...row, state: "ended", result };
				await mutate(async () => [putRow(failed)]);
				return failed;
			}
			const chunks = splitUtf8(JSON.stringify(result.message));
			const { stopReason, usage } = result.message;
			const ended: EgressCallRow = {
				...row,
				state: "ended",
				result: { kind: "message", stopReason, usage, chunks: chunks.length },
			};
			const writes: StoreWrite[] = chunks.map((data, index) => ({
				op: "put",
				key: resultChunkKey(row.callId, index),
				data,
			}));
			await mutate(async () => [...writes, putRow(ended)]);
			return ended;
		},
		async replaceRefused(row, callId) {
			const { stepId, attempt } = stepOf(row);
			const requestJson = await readChunks(row, "request", row.requestChunks, (i) => requestChunkKey(row.callId, i));
			const created = withRequest({ ...row, callId, state: "dispatched", requestChunks: 0 }, requestJson);
			const index: StoreWrite = { op: "put", key: stepIndexKey(stepId, attempt), data: callId };
			const dropped: StoreWrite = { op: "delete", key: callKey(row.callId) };
			await mutate(async () => [dropped, ...chunkDeletes(row), ...created.writes, index]);
			return created.row;
		},
		async supersede(row, variant) {
			const superseded: EgressCallRow = { ...row, state: "superseded" };
			await mutate(async () => [putRow(superseded), ...(variant ? [await variantWrite(variant)] : [])]);
			return superseded;
		},
		async cancelStep(stepId, row) {
			const live = row ? cancelWrites(row) : [];
			await mutate(async () => [{ op: "put", key: cancelledKey(stepId), data: stepId }, ...live]);
		},
		async isCancelled(stepId) {
			return (await store.getDocument(cancelledKey(stepId))) !== undefined;
		},
		async recordVariant(variant) {
			await mutate(async () => [await variantWrite(variant)]);
		},
		async variants(providerId) {
			const prefix = variantPrefix(providerId);
			const entries = await store.scanDocuments(prefix);
			const variants = new Map<DeviceId, VariantRecord>();
			for (const entry of entries) {
				const stored = decodeVariant(entry.data);
				if (!stored) continue;
				const { headDigest, liveAtMismatch, mismatches } = stored;
				variants.set(decodeURIComponent(entry.key.slice(prefix.length)), {
					headDigest,
					liveAtMismatch,
					mismatches,
				});
			}
			return variants;
		},
	};
}
