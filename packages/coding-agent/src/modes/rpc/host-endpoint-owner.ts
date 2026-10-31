/** RED baseline (senpi#4602): today's unfenced endpoint mutations behind the API the fence will take. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hostEnsureLockTarget } from "./host-ensure-lock.ts";
import {
	adoptPublicSocket,
	type SocketFileIdentity,
	shieldSocketDuringClose,
	statSocketIdentity,
} from "./socket-ownership.ts";

export interface EndpointOwnerToken {
	readonly v: 1;
	readonly endpoint: string;
	readonly instanceId: string;
	readonly generation: number;
	readonly pid: number;
	readonly nonce: string;
}

export interface FenceHooks {
	readonly onFenceBusy?: () => void;
}

export function endpointOwnerToken(endpoint: string, instanceId: string, generation: number): EndpointOwnerToken {
	return { v: 1, endpoint, instanceId, generation, pid: process.pid, nonce: randomUUID() };
}

const ownerFile = (socket: string): string => `${hostEnsureLockTarget(socket)}.owner.json`;

export async function readEndpointOwner(socket: string): Promise<EndpointOwnerToken | undefined> {
	try {
		return JSON.parse(await readFile(ownerFile(socket), "utf8")) as EndpointOwnerToken;
	} catch {
		return undefined;
	}
}

export async function claimEndpoint(socket: string, token: EndpointOwnerToken): Promise<void> {
	await mkdir(dirname(ownerFile(socket)), { recursive: true });
	await writeFile(ownerFile(socket), JSON.stringify(token));
}

export async function adoptEndpoint(options: {
	readonly bindSocket: string;
	readonly publicSocket: string;
	readonly expected: SocketFileIdentity | undefined;
	readonly expectedOwner: string | undefined;
	readonly token: EndpointOwnerToken;
	readonly granted?: () => Promise<boolean>;
	readonly hooks?: FenceHooks;
}): Promise<void> {
	await adoptPublicSocket(options.bindSocket, options.publicSocket, options.expected);
}

export async function unlinkOwnedEndpoint(
	socket: string,
	identity: SocketFileIdentity | undefined,
	_instanceId: string,
	_log: (message: string) => void,
	hooks?: { readonly afterValidate?: () => Promise<void> },
): Promise<void> {
	const current = await statSocketIdentity(socket);
	if (!current || !identity || current.dev !== identity.dev || current.ino !== identity.ino) return;
	await hooks?.afterValidate?.();
	await unlink(socket).catch(() => {});
}

export async function closeShieldedEndpoint(socket: string, close: () => Promise<void>): Promise<void> {
	await shieldSocketDuringClose(socket, close);
}

export async function settleCandidateAdoption(
	_socket: string,
	_candidate: string,
	revoke: () => Promise<void>,
): Promise<"completed" | "not_adopted"> {
	await revoke();
	return "not_adopted";
}
