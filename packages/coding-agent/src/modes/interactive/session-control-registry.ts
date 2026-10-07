/**
 * Where a terminal's control socket lives and how it appears in the one endpoint registry
 * (`<agentDir>/rpc-host-daemon/<16hex>/`, kind `tui`).
 *
 * Registration runs under the endpoint's ensure lock (the lock `host gc` takes) and writes the
 * generation record BEFORE `endpoint.json`: a reader that can see the endpoint can always see a
 * live generation behind it, so the endpoint is never judged `dead` while it is being registered.
 * The directory is named by a socket built from a fresh instance id, so it never holds an earlier
 * generation and the registration skips the dead-generation prune a host's directory needs.
 * A TUI endpoint has nothing to reattach to, so a clean exit removes its whole directory.
 */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { engineBuildIdentity } from "../../core/engine-build-identity.ts";
import { createDaemonDirectories, createHostDaemonPaths, type HostDaemonPaths } from "../rpc/host-daemon-paths.ts";
import { thisProcessStartTime, writeHostRegistration } from "../rpc/host-daemon-registration.ts";
import { acquireHostEnsureLock } from "../rpc/host-ensure-lock.ts";
import { MAX_SOCKET_PATH_BYTES } from "../rpc/socket-ownership.ts";
import { socketSecretPath } from "../rpc/socket-transport.ts";
import { tuiSocketName } from "../rpc/tui-socket.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const REGISTRY_LOCK_WAIT_MS = 5_000;

/**
 * `<agentDir>/rpc/tui/t-<16hex>.sock`, or - when the agent directory is too deep for `sun_path` -
 * the same name under `/tmp/senpi-rpc-<sha256(agentDir)[:8]>/tui/`. The fallback root is
 * predictable, so it is used only when it is a real directory owned by this user with no group or
 * other access; anything else fails the registration instead of binding into it.
 */
export async function resolveTuiSocket(agentDir: string, instanceId: string): Promise<string> {
	const name = tuiSocketName(instanceId);
	const primary = join(agentDir, "rpc", "tui", name);
	if (Buffer.byteLength(primary) <= MAX_SOCKET_PATH_BYTES) {
		await makePrivateDirectory(dirname(primary));
		return primary;
	}
	const root = join("/tmp", `senpi-rpc-${createHash("sha256").update(agentDir).digest("hex").slice(0, 8)}`);
	const tuiRoot = join(root, "tui");
	await makePrivateDirectory(tuiRoot);
	for (const directory of [root, tuiRoot]) await assertPrivateDirectory(directory);
	const fallback = join(tuiRoot, name);
	if (Buffer.byteLength(fallback) > MAX_SOCKET_PATH_BYTES) {
		throw new Error(`socket path ${fallback} exceeds ${MAX_SOCKET_PATH_BYTES} bytes`);
	}
	return fallback;
}

async function makePrivateDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	await chmod(directory, PRIVATE_DIRECTORY_MODE);
}

async function assertPrivateDirectory(directory: string): Promise<void> {
	const stat = await lstat(await realpath(directory));
	const ownedByUs = process.getuid === undefined || stat.uid === process.getuid();
	if (!stat.isDirectory() || !ownedByUs || (stat.mode & 0o077) !== 0) {
		throw new Error(`alt_root_unsafe: ${directory} is not a private directory of this user`);
	}
}

export interface TuiRegistryEntry {
	readonly paths: HostDaemonPaths;
	readonly socket: string;
}

export async function registerTuiEndpoint(options: {
	readonly agentDir: string;
	readonly socket: string;
	readonly instanceId: string;
}): Promise<TuiRegistryEntry> {
	const paths = createHostDaemonPaths({ socket: options.socket, agentDir: options.agentDir });
	const release = await acquireHostEnsureLock(options.socket, REGISTRY_LOCK_WAIT_MS);
	try {
		await writeHostRegistration(
			paths,
			{
				record: { pid: process.pid, processStartTime: await thisProcessStartTime() },
				socket: options.socket,
				instanceId: options.instanceId,
				generation: 0,
				launchProfileId: "tui",
				build: engineBuildIdentity(),
			},
			{ fresh: true },
		);
		await createDaemonDirectories(paths, { kind: "tui" });
	} finally {
		await release();
	}
	return { paths, socket: options.socket };
}

export async function unregisterTuiEndpoint(entry: TuiRegistryEntry): Promise<void> {
	const release = await acquireHostEnsureLock(entry.socket, REGISTRY_LOCK_WAIT_MS).catch(() => undefined);
	try {
		await rm(entry.socket, { force: true });
		await rm(socketSecretPath(entry.socket), { force: true });
		await rm(entry.paths.dir, { recursive: true, force: true });
	} finally {
		await release?.();
	}
}

export function unregisterTuiEndpointSync(entry: TuiRegistryEntry): void {
	rmSync(entry.socket, { force: true });
	rmSync(socketSecretPath(entry.socket), { force: true });
	rmSync(entry.paths.dir, { recursive: true, force: true });
}
