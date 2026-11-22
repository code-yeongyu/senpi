import { randomBytes } from "node:crypto";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { loadEntriesFromFileAsync, type SessionManager } from "../session-manager.ts";
import { pathExists } from "../tools/path-utils.ts";
import { isPlainId, parseMoveId } from "./bundle.ts";
import { type MoveId, SESSION_MOVED_IN, SESSION_RELEASED } from "./ownership.ts";

/**
 * State an extension keeps outside the session folder (task records, logs, finished child sessions) and wants to
 * follow a moved session (senpi#3676, design v7 section 4). The sender's extensions write it into a staging folder at
 * the `move` release, while their runtime is still live (`session_move_export`); export bundles that folder as the
 * `extension-state` payload; import unpacks it next to the session (`movedStateDir`); and the next open hands it to the
 * receiver's extensions once (`session_move_import`), then records `session_move_state_restored` and removes it.
 *
 * Every hand-over is per attempt (senpi#3681 delta review): a handler the host stopped waiting on can keep running,
 * so each release attempt stages into its own folder and only the attempt recorded in the seal is bundled, and each
 * import delivery hands out its own copy. A late write therefore only ever lands in a dead attempt's folder.
 */
export const EXTENSION_STATE_PAYLOAD = "extension-state";
export const MOVED_STATE_RESTORED = "session_move_state_restored";
/** The `session_released` field naming the release attempt whose staged state the move bundles. */
export const STATE_ATTEMPT_FIELD = "state_attempt";

const MOVE_STATE = ".move-state";
const DELIVERED_MARKER = "delivered";
const DELIVERY_COPY = "attempt-";

const newAttempt = (): string => randomBytes(8).toString("hex");

/** Every release attempt of `moveId` stages under this folder; finish removes it whole. */
export function outgoingStateDir(sessionFile: string, moveId: MoveId): string {
	return join(dirname(sessionFile), MOVE_STATE, "out", parseMoveId(moveId));
}

export function movedStateDir(sessionFile: string, moveId: MoveId): string {
	return join(dirname(sessionFile), MOVE_STATE, "in", `${basename(sessionFile, ".jsonl")}.${parseMoveId(moveId)}`);
}

interface EntryLike {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
}

const field = (entry: EntryLike, name: string): string | undefined => {
	const { data } = entry;
	if (typeof data !== "object" || data === null || !(name in data)) return undefined;
	const value: unknown = Reflect.get(data, name);
	return typeof value === "string" ? value : undefined;
};

const moveIdOf = (entry: EntryLike): string | undefined => field(entry, "move_id");

function sealedAttempt(entries: readonly EntryLike[], moveId: MoveId): string | undefined {
	const seal = entries.findLast(
		(entry) => entry.type === "custom" && entry.customType === SESSION_RELEASED && moveIdOf(entry) === moveId,
	);
	const attempt = seal === undefined ? undefined : field(seal, STATE_ATTEMPT_FIELD);
	return isPlainId(attempt) ? attempt : undefined;
}

/** The folder of the release attempt that sealed the session for `moveId`, if that release staged one. */
export async function sealedOutgoingStateDir(sessionFile: string, moveId: MoveId): Promise<string | undefined> {
	const attempt = sealedAttempt(await loadEntriesFromFileAsync(sessionFile), moveId);
	return attempt === undefined ? undefined : join(outgoingStateDir(sessionFile, moveId), attempt);
}

/**
 * Creates a fresh, empty folder for one release attempt. Earlier attempts of the move that never sealed the session
 * are dead and removed (a handler still running for one of them may recreate its own folder, which is never read).
 */
export async function prepareOutgoingState(
	sessionFile: string,
	moveId: MoveId,
): Promise<{ readonly attempt: string; readonly dir: string }> {
	const root = outgoingStateDir(sessionFile, moveId);
	const sealed = sealedAttempt(await loadEntriesFromFileAsync(sessionFile), moveId);
	if (await pathExists(root)) {
		for (const name of await readdir(root)) {
			if (name !== sealed) await rm(join(root, name), { recursive: true, force: true });
		}
	}
	const attempt = newAttempt();
	const dir = join(root, attempt);
	await mkdir(dir, { recursive: true });
	return { attempt, dir };
}

/**
 * The state the last move into this session left for its extensions, if it has not been handed over yet. Only the
 * newest `session_moved_in` counts, and only until a `session_move_state_restored` for that move is written.
 */
export async function pendingMovedState(
	sessionFile: string,
): Promise<{ readonly moveId: MoveId; readonly dir: string } | undefined> {
	if (!(await pathExists(sessionFile))) return undefined;
	const entries: readonly EntryLike[] = await loadEntriesFromFileAsync(sessionFile);
	const movedIn = entries.findLast((entry) => entry.type === "custom" && entry.customType === SESSION_MOVED_IN);
	const moveId = movedIn === undefined ? undefined : moveIdOf(movedIn);
	if (moveId === undefined) return undefined;
	const restored = entries.some(
		(entry) => entry.type === "custom" && entry.customType === MOVED_STATE_RESTORED && moveIdOf(entry) === moveId,
	);
	if (restored) return undefined;
	const id = parseMoveId(moveId);
	const dir = movedStateDir(sessionFile, id);
	return (await pathExists(dir)) ? { moveId: id, dir } : undefined;
}

/** Delivery bookkeeping for one pending folder: the `delivered` marker and each delivery's own copy. */
const deliveryDir = (pendingDir: string): string =>
	join(dirname(dirname(pendingDir)), "delivery", basename(pendingDir));

export interface MovedStateDelivery {
	readonly moveId: MoveId;
	readonly dir: string;
	readonly redelivered: boolean;
}

/**
 * Hands pending moved state to the session's extensions: `deliver` runs the import handlers on a fresh copy and
 * resolves `true` when every one of them restored it; only then is the restored marker written and the state removed.
 * A failed handler, or a crash before the marker, delivers it again on the next open with `redelivered` set (handlers
 * must be idempotent). The copy is removed once `deliver` returns, so a handler still running past its budget can
 * never change what a later delivery sees.
 */
export async function restoreMovedState(
	sessionManager: SessionManager,
	deliver: (event: MovedStateDelivery) => Promise<boolean>,
): Promise<void> {
	const sessionFile = sessionManager.getSessionFile();
	if (sessionFile === undefined) return;
	const pending = await pendingMovedState(sessionFile);
	if (pending === undefined) return;
	const bookkeeping = deliveryDir(pending.dir);
	const marker = join(bookkeeping, DELIVERED_MARKER);
	const redelivered = await pathExists(marker);
	if (await pathExists(bookkeeping)) {
		for (const name of await readdir(bookkeeping)) {
			if (name.startsWith(DELIVERY_COPY)) await rm(join(bookkeeping, name), { recursive: true, force: true });
		}
	}
	await mkdir(bookkeeping, { recursive: true });
	await writeFile(marker, "");
	const copy = join(bookkeeping, `${DELIVERY_COPY}${newAttempt()}`);
	await cp(pending.dir, copy, { recursive: true });
	let restored: boolean;
	try {
		restored = await deliver({ moveId: pending.moveId, dir: copy, redelivered });
	} finally {
		await rm(copy, { recursive: true, force: true });
	}
	if (!restored) return;
	sessionManager.appendCustomEntry(MOVED_STATE_RESTORED, {
		move_id: pending.moveId,
		restored_at: new Date().toISOString(),
	});
	await rm(pending.dir, { recursive: true, force: true });
	await rm(bookkeeping, { recursive: true, force: true });
}
