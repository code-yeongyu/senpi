/**
 * Who owns an endpoint's public socket entry, and the fence every rename or remove of that entry runs under
 * (senpi#4602, A-amended section 4, carrying the senpi#2729 ordering rule into endpoint adoption).
 *
 * The owner token names the generation that serves the public name. The fence is a short, cross-process
 * exclusive SQLite lock keyed by the canonical endpoint, the same key the ensure lock uses, but a different file:
 * a predecessor's teardown must be able to finish its own short mutation while a successor's launcher holds the
 * long ensure lock. Inside the fence a writer re-reads the token and the physical entry, mutates, and awaits the
 * mutation before releasing, so a check and its rename can never be split by another writer. The kernel releases
 * the lock when its holder dies; it is never stolen by age or by a pid guess. No RPC, presenter exchange or
 * child-exit wait runs while it is held.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hostEnsureLockOptions, hostEnsureLockTarget } from "./host-ensure-lock.ts";
import { acquireOwnershipSafeLock, isBusy } from "./ownership-safe-lock.ts";
import {
	adoptPublicSocket,
	type SocketFileIdentity,
	shieldSocketDuringClose,
	unlinkOwnedSocket,
} from "./socket-ownership.ts";

/** P6's allowance: a fenced mutation that cannot start within it refuses without mutating anything. */
const ENDPOINT_FENCE_WAIT_MS = 15_000;

export interface EndpointOwnerToken {
	readonly v: 1;
	readonly endpoint: string;
	readonly instanceId: string;
	readonly generation: number;
	readonly pid: number;
	/** Fresh per claim: two claims by one generation are still two different tokens. */
	readonly nonce: string;
}

export interface FenceHooks {
	/** Test seam: the fence was held by another writer when this one asked for it. */
	readonly onFenceBusy?: () => void;
}

export function endpointOwnerToken(endpoint: string, instanceId: string, generation: number): EndpointOwnerToken {
	return { v: 1, endpoint, instanceId, generation, pid: process.pid, nonce: randomUUID() };
}

const ownerFile = (socket: string): string => `${hostEnsureLockTarget(socket)}.owner.json`;

async function withEndpointFence<T>(socket: string, run: () => Promise<T>, hooks?: FenceHooks): Promise<T> {
	const fence = `${hostEnsureLockTarget(socket)}.fence.lock`;
	await mkdir(dirname(fence), { recursive: true });
	let release: () => Promise<void>;
	try {
		release = await acquireOwnershipSafeLock(fence, { retries: { retries: 0, minTimeout: 1, maxTimeout: 1 } });
	} catch (cause) {
		if (!isBusy(cause)) throw cause;
		hooks?.onFenceBusy?.();
		release = await acquireOwnershipSafeLock(fence, hostEnsureLockOptions(ENDPOINT_FENCE_WAIT_MS));
	}
	try {
		return await run();
	} finally {
		await release();
	}
}

/** The current owner token; `undefined` when none was claimed or it cannot be read as one. */
export async function readEndpointOwner(socket: string): Promise<EndpointOwnerToken | undefined> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(ownerFile(socket), "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const token = parsed as Record<string, unknown>;
	return token.v === 1 && typeof token.instanceId === "string" && typeof token.nonce === "string"
		? (parsed as EndpointOwnerToken)
		: undefined;
}

async function writeEndpointOwner(socket: string, token: EndpointOwnerToken): Promise<void> {
	const path = ownerFile(socket);
	const staged = `${path}.${process.pid}.tmp`;
	await writeFile(staged, `${JSON.stringify(token)}\n`, { mode: 0o600 });
	await rename(staged, path);
}

/** An initial start: binds the public name (`bind`, with its stale-entry preparation) and claims it, in one fence. */
export async function claimEndpoint(
	socket: string,
	token: EndpointOwnerToken,
	bind?: () => Promise<void>,
): Promise<void> {
	await withEndpointFence(socket, async () => {
		await bind?.();
		await writeEndpointOwner(socket, token);
	});
}

/**
 * A successor takes the public name over. Inside the fence: the launcher's grant must still stand, the owner token
 * must still name the expected predecessor (when the predecessor participates in the fence at all), the entry must
 * still be the one the handoff was decided against; then the rename and the new token, awaited.
 */
export async function adoptEndpoint(options: {
	readonly bindSocket: string;
	readonly publicSocket: string;
	readonly expected: SocketFileIdentity | undefined;
	/** The predecessor's instanceId; `undefined` for a predecessor that does not advertise the fence (senpi#4602 Q1). */
	readonly expectedOwner: string | undefined;
	readonly token: EndpointOwnerToken;
	/** Whether the launcher's publication grant still stands; absent for an uncoordinated launch. */
	readonly granted?: () => Promise<boolean>;
	readonly hooks?: FenceHooks;
}): Promise<void> {
	const { publicSocket } = options;
	await withEndpointFence(
		publicSocket,
		async () => {
			if (options.granted && !(await options.granted()))
				throw new Error(`${publicSocket}: the launcher revoked this generation's adoption grant`);
			const current = await readEndpointOwner(publicSocket);
			if (options.expectedOwner !== undefined && current && current.instanceId !== options.expectedOwner)
				throw new Error(
					`${publicSocket}: owner token names ${current.instanceId}, not ${options.expectedOwner}; refusing to replace it`,
				);
			await adoptPublicSocket(options.bindSocket, publicSocket, options.expected);
			await writeEndpointOwner(publicSocket, options.token);
		},
		options.hooks,
	);
}

/**
 * A generation removes its public entry: only while the owner token does not name another generation, and only
 * the entry `identity` describes. Its own token goes with it.
 */
export async function unlinkOwnedEndpoint(
	socket: string,
	identity: SocketFileIdentity | undefined,
	instanceId: string,
	log: (message: string) => void,
	hooks?: { readonly afterValidate?: () => Promise<void> },
): Promise<void> {
	await withEndpointFence(socket, async () => {
		const current = await readEndpointOwner(socket);
		if (current && current.instanceId !== instanceId) {
			log(`socket path ${socket} is owned by generation ${current.instanceId} now; leaving it`);
			return;
		}
		await hooks?.afterValidate?.();
		await unlinkOwnedSocket(socket, identity, log);
		if (current) await rm(ownerFile(socket), { force: true });
	});
}

/**
 * Closes a listener bound to `socket` with the entry shielded from libuv's close-time unlink of the NAME. The
 * shield moves whatever entry is there aside and puts that same entry back: inside the fence, so no adoption can
 * land in between and be overwritten by the restore.
 */
export async function closeShieldedEndpoint(socket: string, close: () => Promise<void>): Promise<void> {
	await withEndpointFence(socket, () => shieldSocketDuringClose(socket, close));
}

/**
 * A successor's launcher, after its attempt failed: revoke the publication grant, then read who owns the public
 * name. An adoption that started inside its window but committed after the deadline is a COMPLETED handoff, never
 * rolled back; one that did not commit before the revocation can no longer commit at all.
 */
export async function settleCandidateAdoption(
	socket: string,
	candidate: string,
	revoke: () => Promise<void>,
): Promise<"completed" | "not_adopted"> {
	return withEndpointFence(socket, async () => {
		await revoke();
		return (await readEndpointOwner(socket))?.instanceId === candidate ? "completed" : "not_adopted";
	});
}
