import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	createAdmissionLine,
	createMemoryStoreMedium,
	createWakeOutbox,
	type HandWakeLink,
	type MemoryStoreMedium,
	openMemoryStore,
	type SyncCommitStore,
	type WakeOutbox,
} from "@earendil-works/pi-agent-core";
import type { StoreRecord, StoreValue } from "@earendil-works/pi-agent-core/conformance";
import type { HandWakes } from "../rpc/remote-executor-scope.ts";

type MediumState = MemoryStoreMedium["current"];

export class HandWakeStoreError extends Error {
	override readonly name = "HandWakeStoreError";
	readonly path: string;
	constructor(path: string, what: string) {
		super(`the hand's wake store ${path} is unreadable: ${what}`);
		this.path = path;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isStoreRecord = (value: unknown): value is StoreRecord =>
	isRecord(value) &&
	typeof value.seq === "number" &&
	typeof value.id === "string" &&
	typeof value.kind === "string" &&
	"data" in value;

const isDocument = (value: unknown): value is [string, StoreValue] =>
	Array.isArray(value) && value.length === 2 && typeof value[0] === "string";

function decode(path: string, text: string): MediumState {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new HandWakeStoreError(path, error instanceof Error ? error.message : String(error));
	}
	if (
		!isRecord(value) ||
		typeof value.epoch !== "number" ||
		!Array.isArray(value.records) ||
		!value.records.every(isStoreRecord) ||
		!Array.isArray(value.documents) ||
		!value.documents.every(isDocument)
	)
		throw new HandWakeStoreError(path, "not a wake store");
	return { epoch: value.epoch, records: value.records, documents: new Map(value.documents) };
}

function readState(path: string): MediumState {
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return createMemoryStoreMedium().current;
		throw error;
	}
	return decode(path, text);
}

function fsyncPath(path: string, flags: string): void {
	const fd = openSync(path, flags);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function writeState(path: string, state: MediumState): void {
	const temporary = `${path}.${process.pid}.tmp`;
	const text = JSON.stringify({ epoch: state.epoch, records: state.records, documents: [...state.documents] });
	writeFileSync(temporary, text, { mode: 0o600 });
	fsyncPath(temporary, "r+");
	renameSync(temporary, path);
	// A directory cannot be opened for fsync on Windows; the rename there is already durable once it returns.
	if (process.platform !== "win32") fsyncPath(dirname(path), "r");
}

/**
 * The hand's durable store for its wake outbox (brain/hand split H3): the memory store's commit semantics over one
 * owner-only JSON file, written atomically on every commit, so a wake committed before a hand process dies is re-offered
 * by the next one. Each opening claims the next owner epoch, so a process that still holds an older one is fenced.
 */
export async function openHandWakeStore(
	path: string,
): Promise<{ readonly store: SyncCommitStore; readonly epoch: number }> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	let state = readState(path);
	const medium: MemoryStoreMedium = {
		get current() {
			return state;
		},
		set current(next) {
			writeState(path, next);
			state = next;
		},
	};
	const store = openMemoryStore(medium);
	const epoch = (await store.readEpoch()) + 1;
	await store.claim(epoch - 1, epoch);
	return { store, epoch };
}

/** The hand's wake outbox on its durable store: every event id it mints starts with `hand:`. */
export async function openHandWakeOutbox(path: string, clock: () => number = Date.now): Promise<WakeOutbox> {
	const { store, epoch } = await openHandWakeStore(path);
	return createWakeOutbox({ hand: "hand", store, epoch, admission: createAdmissionLine(), clock });
}

/** A hand's scopes' wakes over its wake link; the link reports every failure itself, so nothing here throws. */
export function handWakesOver(link: HandWakeLink): HandWakes {
	return {
		offer: (scope, wake) => void link.offer({ scope, ...wake }),
		closeScope: (scope) => void link.closeScope(scope),
	};
}
