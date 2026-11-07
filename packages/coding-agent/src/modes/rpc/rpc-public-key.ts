import { randomBytes, randomUUID } from "node:crypto";
import { constants, type Stats, unlinkSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
	ProcessIdentityUnreadableError,
	processMatchesPidFile,
	readProcessStartTime,
} from "../../utils/process-identity.ts";
import { authRecord, RPC_AUTH_HEX, RPC_LAUNCH_ID, RpcEndpointAuthError } from "./rpc-auth-proof.ts";

const MAX_KEY_RECORD_BYTES = 4096;

/**
 * Key-root rule (#3795, shared with the desktop and omo clients): `<root>` and `<root>/rpc` are checked at their
 * realpath and must be directories owned by this user with no group/other write (0755 is fine); `<root>/rpc/keys`
 * itself must be a real (non-symlink) directory owned by this user with mode exactly 0700.
 */
export async function checkRpcKeyDirectory(path: string, privateKeys = false): Promise<void> {
	const checked = privateKeys ? path : await fs.realpath(path);
	const problem = keyDirectoryProblem(await fs.lstat(checked), checked, privateKeys);
	if (problem !== undefined) throw new RpcEndpointAuthError("unsafe_key_record", `${checked} ${problem}`);
}

/** What is wrong with one key-root directory, worded so the message names the fix (senpi#3815 review L6). */
function keyDirectoryProblem(info: Stats, path: string, privateKeys: boolean): string | undefined {
	if (!info.isDirectory()) return "is not a directory";
	if (info.uid !== process.getuid?.()) return "is not owned by this user";
	const mode = info.mode & 0o7777;
	if (privateKeys)
		return mode === 0o700 ? undefined : `must be mode 0700 (is 0${mode.toString(8)}); run: chmod 700 ${path}`;
	return (mode & 0o022) === 0 ? undefined : `is writable by group or others; run: chmod go-w ${path}`;
}

async function checkRpcKeyParents(root: string): Promise<void> {
	await checkRpcKeyDirectory(root);
	await checkRpcKeyDirectory(join(root, "rpc"));
}

export async function readRpcKeyRecord(
	root: string,
	launchId: string,
): Promise<Readonly<Record<string, unknown>> | undefined> {
	if (!RPC_LAUNCH_ID.test(launchId))
		throw new RpcEndpointAuthError("unsafe_key_record", `invalid launch id under ${root}`);
	const path = join(root, "rpc", "keys", launchId);
	try {
		await checkRpcKeyParents(root);
		await checkRpcKeyDirectory(join(root, "rpc", "keys"), true);
		const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = await handle.stat();
			if (
				!info.isFile() ||
				info.uid !== process.getuid?.() ||
				(info.mode & 0o7777) !== 0o600 ||
				info.size > MAX_KEY_RECORD_BYTES
			)
				throw new RpcEndpointAuthError("unsafe_key_record", path);
			const record = authRecord(JSON.parse(await handle.readFile("utf8")));
			if (
				record?.version !== 1 ||
				record.launch_id !== launchId ||
				typeof record.key !== "string" ||
				!RPC_AUTH_HEX.test(record.key)
			)
				throw new RpcEndpointAuthError("unsafe_key_record", path);
			return record;
		} finally {
			await handle.close();
		}
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
		if (cause instanceof RpcEndpointAuthError) throw cause;
		throw new RpcEndpointAuthError("unsafe_key_record", path, { cause });
	}
}

/** One public binder owns one in-memory key; it never reads a key back from disk. */
export class RpcPublicEndpoint {
	readonly key = randomBytes(32);
	readonly launchId = randomUUID();
	readonly recordPath: string;
	readonly ready: Promise<void>;
	private readonly publication = Promise.withResolvers<void>();
	private created = false;
	private readonly exitCleanup = () => {
		if (!this.created) return;
		try {
			unlinkSync(this.recordPath);
		} catch (cause) {
			if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
				process.stderr.write("senpi rpc host: could not remove own endpoint key record\n");
		}
	};

	readonly agentDir: string;
	readonly endpoint: string;

	constructor(agentDir: string, endpoint: string) {
		this.agentDir = agentDir;
		this.endpoint = endpoint;
		this.recordPath = join(agentDir, "rpc", "keys", this.launchId);
		this.ready = this.publication.promise;
		this.ready.catch(() => {});
	}

	async publish(): Promise<void> {
		try {
			await fs.mkdir(join(this.agentDir, "rpc"), { recursive: true, mode: 0o700 });
			await checkRpcKeyParents(this.agentDir);
			const keys = join(this.agentDir, "rpc", "keys");
			await fs.mkdir(keys, { recursive: true, mode: 0o700 });
			// An existing keys directory this user owns is tightened; a symlink or a foreign one is refused.
			const directory = await fs.lstat(keys);
			if (!directory.isDirectory() || directory.uid !== process.getuid?.())
				throw new RpcEndpointAuthError("unsafe_key_record", keys);
			if ((directory.mode & 0o7777) !== 0o700) await fs.chmod(keys, 0o700);
			await checkRpcKeyDirectory(keys, true);
			const handle = await fs.open(
				this.recordPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			this.created = true;
			process.once("exit", this.exitCleanup);
			try {
				await handle.writeFile(
					JSON.stringify({
						version: 1,
						launch_id: this.launchId,
						key: this.key.toString("hex"),
						pid: process.pid,
						process_start: (await readProcessStartTime(process.pid)) ?? null,
						endpoint: this.endpoint,
						created_at: new Date().toISOString(),
					}),
				);
				await handle.sync();
				const info = await handle.stat();
				if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600)
					throw new RpcEndpointAuthError("unsafe_key_record", this.recordPath);
			} finally {
				await handle.close();
			}
			this.publication.resolve();
		} catch (cause) {
			const error = new RpcEndpointAuthError(
				"key_publication_failed",
				cause instanceof RpcEndpointAuthError ? cause.message : this.recordPath,
				{ cause },
			);
			this.publication.reject(error);
			throw error;
		}
	}

	async dispose(): Promise<void> {
		process.off("exit", this.exitCleanup);
		if (!this.created) return;
		this.created = false;
		await fs.unlink(this.recordPath).catch((cause: unknown) => {
			if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
		});
	}
}

/** Unknown process identity keeps a record; only death or observed PID reuse permits collection. */
export async function gcRpcPublicKeys(
	agentDir: string,
	budget: { readonly deadline?: number; readonly maxRecords?: number } = {},
): Promise<void> {
	const keys = join(agentDir, "rpc", "keys");
	try {
		await checkRpcKeyParents(agentDir);
		await checkRpcKeyDirectory(keys, true);
	} catch (cause) {
		if (cause instanceof RpcEndpointAuthError) return;
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
		throw cause;
	}
	const names = await fs.readdir(keys).catch((cause: unknown) => {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
		throw cause;
	});
	let examined = 0;
	for (const name of names) {
		if (Date.now() >= (budget.deadline ?? Infinity) || examined >= (budget.maxRecords ?? Infinity)) break;
		if (!RPC_LAUNCH_ID.test(name)) continue;
		examined++;
		try {
			const record = await readRpcKeyRecord(agentDir, name);
			if (
				record === undefined ||
				typeof record.pid !== "number" ||
				!Number.isSafeInteger(record.pid) ||
				record.pid <= 0 ||
				!(record.process_start === null || typeof record.process_start === "string")
			)
				continue;
			if (await processMatchesPidFile({ pid: record.pid, processStartTime: record.process_start })) continue;
			await fs.unlink(join(keys, name));
		} catch (cause) {
			if (cause instanceof ProcessIdentityUnreadableError || cause instanceof RpcEndpointAuthError) continue;
			if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
			throw cause;
		}
	}
}
