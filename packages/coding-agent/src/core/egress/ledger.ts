/**
 * The brain's `egress_call` ledger (row CK9; custody design 4.5). Every write is one admitted mutation supplied by the
 * host wrapper, which fences it (epoch, admission seq, instance generation) and commits it atomically; the ledger only
 * builds the writes. W4 (row + request chunks) precedes any dial, W4' (`hooked`) replaces the request and sets
 * `hooksApplied` in one mutation, `ended` is durable before the terminal event, and the step commit (W9) closes the row
 * and deletes its request chunks with `closeCallWrites` inside its own mutation.
 */
import type { DeviceId, ProviderId } from "@earendil-works/pi-agent-core";
import type { DurableStore, StoreWrite } from "@earendil-works/pi-agent-core/conformance";
import {
	callKey,
	cancelledKey,
	decodeCallRow,
	decodeVariant,
	type EgressCallResult,
	type EgressCallRow,
	encodeCallRow,
	encodeVariant,
	requestChunkKey,
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
	/** W4. With `previous`, the previous row is retired (`ended` -> `closed`) and its request chunks deleted, atomically. */
	dispatch(next: NewCallRow, requestJson: string, previous?: EgressCallRow): Promise<EgressCallRow>;
	/** W4': the post-hook request replaces the stored one and `hooksApplied` becomes true, in one mutation. */
	recordHooked(row: EgressCallRow, requestJson: string): Promise<EgressCallRow>;
	end(row: EgressCallRow, result: EgressCallResult): Promise<EgressCallRow>;
	/** The row is superseded; a definition mismatch records the device variant in the same mutation. */
	supersede(row: EgressCallRow, variant?: VariantMismatch): Promise<EgressCallRow>;
	/** W14: the step is cancelled (and its live row with it); a cancelled step is never dialed again. */
	cancelStep(stepId: string, row: EgressCallRow | undefined): Promise<void>;
	isCancelled(stepId: string): Promise<boolean>;
	recordVariant(variant: VariantMismatch): Promise<void>;
	variants(providerId: ProviderId): Promise<ReadonlyMap<DeviceId, VariantRecord>>;
}

const putRow = (row: EgressCallRow): StoreWrite => ({ op: "put", key: callKey(row.callId), data: encodeCallRow(row) });

const chunkDeletes = (row: EgressCallRow): StoreWrite[] =>
	Array.from({ length: row.requestChunks }, (_, index) => ({ op: "delete", key: requestChunkKey(row.callId, index) }));

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

	return {
		async rowsForStep(stepId) {
			const index = await store.scanDocuments(stepIndexPrefix(stepId));
			const rows = await Promise.all(
				index.map((entry) => (typeof entry.data === "string" ? readRow(entry.data) : undefined)),
			);
			return rows.filter((row): row is EgressCallRow => row !== undefined);
		},
		async readRequest(row) {
			const keys = Array.from({ length: row.requestChunks }, (_, index) => requestChunkKey(row.callId, index));
			const chunks = await Promise.all(keys.map((key) => store.getDocument(key)));
			if (!chunks.every((chunk): chunk is string => typeof chunk === "string"))
				throw new Error(`egress_call ${row.callId}: stored request is incomplete`);
			return chunks.join("");
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
			const ended: EgressCallRow = { ...row, state: "ended", result };
			await mutate(async () => [putRow(ended)]);
			return ended;
		},
		async supersede(row, variant) {
			const superseded: EgressCallRow = { ...row, state: "superseded" };
			await mutate(async () => [putRow(superseded), ...(variant ? [await variantWrite(variant)] : [])]);
			return superseded;
		},
		async cancelStep(stepId, row) {
			const live =
				row && (row.state === "dispatched" || row.state === "ended")
					? [putRow({ ...row, state: "cancelled" })]
					: [];
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
