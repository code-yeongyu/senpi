/**
 * The `hand_link` endpoint's durable store: agent-core's memory backend (`openMemoryStore`, which passes the STORE
 * conformance cases) over a medium kept in one JSON file. The backend reads `medium.current` once per operation and
 * assigns it once with the next state, so the setter writing the file is the commit: a temporary file in the same
 * directory, fsynced, renamed over the old one and the directory fsynced. A crash leaves the old or the new state,
 * never a mix, and a commit is durable before the backend adopts it.
 *
 * The getter reads the file every time, so a newer daemon generation's claim (a higher owner epoch) is seen by an
 * older one, whose next commit is then refused `stale-epoch` instead of overwriting the newer state.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMemoryStoreMedium, openMemoryStore, type SyncCommitStore } from "@earendil-works/pi-agent-core";
import type { StoreValue } from "@earendil-works/pi-agent-core/conformance";

type Medium = ReturnType<typeof createMemoryStoreMedium>;
type MediumState = Medium["current"];

/** Where the endpoint keeps its state: `<agentDir>/rpc/hand-link/state.json`. */
export function handLinkStatePath(agentDir: string): string {
	return join(agentDir, "rpc", "hand-link", "state.json");
}

class HandLinkStateCorruptError extends Error {
	constructor(path: string, reason: string) {
		super(`the hand_link state file ${path} is unreadable: ${reason}`);
		this.name = "HandLinkStateCorruptError";
	}
}

function readState(path: string): MediumState {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return createMemoryStoreMedium().current;
		throw error;
	}
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) throw new HandLinkStateCorruptError(path, "not an object");
	const { epoch, records, documents } = parsed as Record<string, unknown>;
	if (typeof epoch !== "number" || !Array.isArray(records) || !Array.isArray(documents))
		throw new HandLinkStateCorruptError(path, "missing epoch, records or documents");
	return {
		epoch,
		records: records as MediumState["records"],
		documents: new Map(documents as [string, StoreValue][]),
	};
}

function writeState(path: string, state: MediumState): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const file = openSync(temporary, "wx", 0o600);
	try {
		writeSync(file, JSON.stringify({ epoch: state.epoch, records: state.records, documents: [...state.documents] }));
		fsyncSync(file);
	} finally {
		closeSync(file);
	}
	renameSync(temporary, path);
	const handle = openSync(directory, "r");
	try {
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
}

/** The durable store kept in `path`; created with the first commit. */
export function openHandLinkFileStore(path: string): SyncCommitStore {
	const medium: Medium = {
		get current() {
			return readState(path);
		},
		set current(state) {
			writeState(path, state);
		},
	};
	return openMemoryStore(medium);
}
