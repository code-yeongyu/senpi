/**
 * Which session file each generation of the daemon currently holds open.
 *
 * Inside one host process the registry's own reservation set is the authority. Across
 * GENERATIONS it cannot be: during a handoff two hosts are alive at the same time, and the
 * successor must not open a session file the predecessor is still writing - two writers on
 * one JSONL interleave partial records and the transcript is silently corrupted.
 *
 * So every open publishes a small claim next to the daemon state, and every close removes it.
 * A claim is evidence, not a lock: it names the process that made it, so a claim whose owner is
 * gone (a SIGKILLed host, a reboot, a recycled pid with a different start time) is ignored
 * rather than trusted. The failure mode is therefore "a reopen waits ~2s for a live writer to
 * finish", never "a session file can never be opened again".
 *
 * Liveness alone was not enough evidence. A generation that lost the socket stays alive holding
 * retained sessions nobody is attached to, and its claims then refused every reopen of those files
 * for as long as the process existed (#1893). So a claim counts while its owner is the generation
 * the pointer names, or while the owner still has a client attached to that session - and a
 * superseded, attachment-less claim is reclaimable, because the generation that made it has been
 * asked to drain and parks that session as it settles.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	processIsLive,
	processStartTimeMs,
	readProcessStartTime,
	sameProcessStartMs,
} from "../app-server/daemon/process.ts";
import { createHostDaemonPaths, HOST_DAEMON_DIR_ENV, hostDaemonDirectoryPaths } from "./host-daemon-paths.ts";
import { parseJson, readFileOrUndefined } from "./host-daemon-state.ts";
import { logUnknownHostIdentity } from "./host-supervisor-log.ts";

/** How long a client should wait before retrying a path another generation still holds. */
export const SESSION_PATH_RETRY_AFTER_MS = 2_000;

export interface SessionPathOwner {
	readonly instanceId: string;
	readonly pid: number;
	readonly processStartTime: string | null;
	readonly sessionPath: string;
	/** Whether the owner had a client attached when it last published this claim. */
	readonly attached?: boolean;
	/** Whether the owner is the generation the pointer names. Answered on read, never stored. */
	readonly current?: boolean;
}

export interface SessionPathReservations {
	/** Live processes registered to this daemon, never inferred from a holder's own labels. */
	holderPids?(observedStarts?: ReadonlyMap<number, number | undefined>): Promise<readonly number[]>;
	/** Records this host as the holder of `sessionPath`, or reports the holder whose claim stands. */
	claim(sessionPath: string, attached?: boolean): Promise<SessionPathOwner | undefined>;
	/** Drops this host's claim. A claim made by another generation is never touched. */
	release(sessionPath: string): Promise<void>;
	/** Republishes this host's claim with the attachment state that session now has. */
	setAttached(sessionPath: string, attached: boolean): void;
}

/** One published claim, as a reader of the directory finds it. */
export interface SessionPathClaim {
	readonly file: string;
	readonly owner: SessionPathOwner;
}

/** One claim per canonical session path, named by its hash so the file name is bounded. */
export function reservationFile(dir: string, sessionPath: string): string {
	return join(dir, `${createHash("sha256").update(sessionPath, "utf8").digest("hex").slice(0, 16)}.json`);
}

/**
 * The claims of a host serving one ENDPOINT, or none when there is no endpoint to share. A
 * supervised host is TOLD its daemon directory, because the socket it binds is a private hop rather
 * than the public endpoint; a bare socket host derives it from what it listens on; a stdio host has
 * no daemon directory, no successor generation and therefore nothing to publish.
 */
export function createEndpointReservations(host: {
	readonly agentDir: string;
	readonly socket: string | undefined;
	readonly instanceId: string;
	readonly onFailure?: (message: string) => void;
}): SessionPathReservations | undefined {
	const told = process.env[HOST_DAEMON_DIR_ENV];
	const dir =
		told !== undefined && told.trim() !== ""
			? told
			: host.socket === undefined
				? undefined
				: createHostDaemonPaths({ socket: host.socket, agentDir: host.agentDir }).dir;
	if (dir === undefined) return undefined;
	return createSessionPathReservations({
		daemonDir: dir,
		instanceId: host.instanceId,
		...(host.onFailure ? { onFailure: host.onFailure } : {}),
	});
}

export function createSessionPathReservations(options: {
	/** This endpoint's daemon directory: the claims live in it, and so does the pointer they are read against. */
	readonly daemonDir: string;
	readonly instanceId: string;
	readonly pid?: number;
	readonly onFailure?: (message: string) => void;
}): SessionPathReservations {
	const paths = hostDaemonDirectoryPaths(options.daemonDir);
	const dir = paths.reservationsDir;
	const pid = options.pid ?? process.pid;
	const startTime = readProcessStartTime(pid).then(
		(value) => value ?? null,
		() => null,
	);
	const held = new Set<string>();
	const updates = new Map<string, Promise<void>>();
	const report = (message: string): void => options.onFailure?.(message);
	const publish = async (sessionPath: string, attached: boolean, stillHeld?: () => boolean): Promise<void> => {
		const owner: SessionPathOwner = {
			instanceId: options.instanceId,
			pid,
			processStartTime: await startTime,
			sessionPath,
			attached,
		};
		const file = reservationFile(dir, sessionPath);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		// Written aside and renamed in: a reader never sees half a claim.
		const staging = `${file}.${pid}.tmp`;
		await writeFile(staging, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
		// A republish that raced the release of the same path must not resurrect the claim: this host
		// parks a session milliseconds after it detaches, and a loaded event loop can reorder the two.
		if (stillHeld?.() === false) {
			await rm(staging, { force: true });
			return;
		}
		await rename(staging, file);
	};
	return {
		async holderPids(observedStarts?: ReadonlyMap<number, number | undefined>): Promise<readonly number[]> {
			const candidates = (await readSessionPathClaims(dir)).map(({ owner }) => owner);
			const generations = await readdir(paths.generationsDir, { withFileTypes: true }).catch(() => []);
			for (const generation of generations) {
				if (!generation.isDirectory()) continue;
				const record = parseJson(
					await readFileOrUndefined(join(paths.generationsDir, generation.name, "host-child.pid")),
				);
				if (typeof record?.pid !== "number") continue;
				candidates.push({
					pid: record.pid,
					processStartTime: typeof record.processStartTime === "string" ? record.processStartTime : null,
					instanceId: generation.name,
					sessionPath: "",
				});
			}
			const byPid = new Map<number, SessionPathOwner[]>();
			for (const owner of candidates) {
				if (owner.pid === process.pid) continue;
				const owners = byPid.get(owner.pid) ?? [];
				owners.push(owner);
				byPid.set(owner.pid, owners);
			}
			const live = await Promise.all(
				[...byPid].map(async ([pid, owners]) => {
					if (!processIsLive(pid)) return undefined;
					if (observedStarts) {
						// Only foreign-looking holders need family classification. Their bounded OS
						// probes were already done by lease validation at this command's admission.
						if (!observedStarts.has(pid)) return undefined;
						const observed = observedStarts.get(pid);
						return owners.some((owner) => {
							if (owner.processStartTime === null) return false;
							return sameProcessStartMs(processStartTimeMs(owner.processStartTime), observed);
						})
							? pid
							: undefined;
					}
					const current = await readProcessStartTime(pid, process.platform, 1_000).catch(() => undefined);
					return current !== undefined && owners.some((owner) => owner.processStartTime === current)
						? pid
						: undefined;
				}),
			);
			return [...new Set(live.filter((value): value is number => value !== undefined))];
		},
		async claim(sessionPath: string, attached = true): Promise<SessionPathOwner | undefined> {
			const existing = await readOwner(reservationFile(dir, sessionPath));
			if (existing && existing.pid !== pid) {
				const standing = await standingOwner(existing, paths.pointerFile);
				if (standing) return standing;
			}
			try {
				await publish(sessionPath, attached);
				held.add(sessionPath);
			} catch (cause) {
				// A daemon directory that cannot be written is not a reason to refuse a session: the
				// in-process reservation still protects this host, and a handoff is the only thing
				// that loses its guard. Say so once rather than failing the open.
				report(`session path reservation for ${sessionPath} could not be written (${errorMessage(cause)})`);
			}
			return undefined;
		},
		async release(sessionPath: string): Promise<void> {
			if (!held.delete(sessionPath)) return;
			await updates.get(sessionPath);
			updates.delete(sessionPath);
			await rm(reservationFile(dir, sessionPath), { force: true }).catch((cause: unknown) => {
				report(`session path reservation for ${sessionPath} could not be removed (${errorMessage(cause)})`);
			});
		},
		setAttached(sessionPath: string, attached: boolean): void {
			if (!held.has(sessionPath)) return;
			const update = (updates.get(sessionPath) ?? Promise.resolve())
				.then(() => publish(sessionPath, attached, () => held.has(sessionPath)))
				.catch((cause: unknown) => {
					report(`session path reservation for ${sessionPath} could not be updated (${errorMessage(cause)})`);
				});
			updates.set(sessionPath, update);
		},
	};
}

/** Every claim published in one reservations directory, for a reader pruning or reporting them. */
export async function readSessionPathClaims(dir: string): Promise<readonly SessionPathClaim[]> {
	const entries = await readdir(dir).catch(() => [] as string[]);
	const claims: SessionPathClaim[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const file = join(dir, entry);
		const owner = await readOwner(file);
		if (owner) claims.push({ file, owner });
	}
	return claims;
}

/**
 * The claim that STANDS against a new open, or nothing when this path may be taken over.
 *
 * A claim is honored while its owner is the generation serving the socket, or while that owner
 * still has a client attached to the session - those are the two cases where somebody is really
 * writing the file. A superseded owner that published `attached: false` is draining (or should
 * be), so its claim is released rather than obeyed. A claim without the flag predates it and is
 * honored, so a running older generation is never reclaimed from.
 */
async function standingOwner(owner: SessionPathOwner, pointerFile: string): Promise<SessionPathOwner | undefined> {
	if (!(await claimOwnerIsLive(owner))) return undefined;
	const current = (await currentInstanceId(pointerFile)) === owner.instanceId;
	return current || owner.attached !== false ? { ...owner, current } : undefined;
}

/** The generation the pointer names, or nothing when no pointer describes this endpoint. */
async function currentInstanceId(pointerFile: string): Promise<string | undefined> {
	const pointer = parseJson(await readFileOrUndefined(pointerFile).catch(() => undefined));
	return typeof pointer?.instance_id === "string" ? pointer.instance_id : undefined;
}

async function readOwner(file: string): Promise<SessionPathOwner | undefined> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch {
		// Absent, unreadable or half-written: no claim that anyone could act on.
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { instanceId, pid, processStartTime, sessionPath, attached } = parsed as Record<string, unknown>;
	if (typeof instanceId !== "string" || typeof pid !== "number" || typeof sessionPath !== "string") return undefined;
	return {
		instanceId,
		pid,
		processStartTime: typeof processStartTime === "string" ? processStartTime : null,
		sessionPath,
		...(typeof attached === "boolean" ? { attached } : {}),
	};
}

/**
 * A claim counts only while the process that made it is still running. The recorded start time is
 * what separates "that host is still writing" from "the OS handed its pid to something else".
 */
export async function claimOwnerIsLive(owner: SessionPathOwner): Promise<boolean> {
	if (!processIsLive(owner.pid)) return false;
	const recorded = owner.processStartTime === null ? undefined : processStartTimeMs(owner.processStartTime);
	if (recorded === undefined) {
		logUnknownHostIdentity("session-path-claim", owner.pid);
		return true;
	}
	const current = await readProcessStartTime(owner.pid).catch(() => undefined);
	const observed = current === undefined ? undefined : processStartTimeMs(current);
	return observed === undefined || sameProcessStartMs(recorded, observed);
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
