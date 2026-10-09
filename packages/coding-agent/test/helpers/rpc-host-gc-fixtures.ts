/**
 * Fixtures for the `host gc` suite: endpoint states built on disk without a host, sockets that
 * refuse or answer on demand, and a gate that holds a critical section open until the test says so.
 *
 * A REFUSING socket needs a real socket file with no listener. Closing a listening server would not
 * leave one - libuv unlinks the path it bound - so `refusingSocket` moves the entry aside for the
 * close and back afterwards, exactly as `shieldSocketDuringClose` does in production.
 */
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { basename, dirname, join } from "node:path";
import { createDaemonDirectories, createHostDaemonPaths } from "../../src/modes/rpc/host-daemon-paths.ts";

export async function deadEndpoint(socket: string, agentDir: string) {
	const paths = createHostDaemonPaths({ socket, agentDir });
	await createDaemonDirectories(paths);
	return paths;
}

export async function refusingSocket(path: string): Promise<void> {
	const server = await listeningSocket(path);
	const aside = `${path}.aside`;
	await rename(path, aside);
	await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	await rename(aside, path);
}

export async function listeningSocket(path: string): Promise<Server> {
	await mkdir(dirname(path), { recursive: true });
	const server = createServer((connection) => connection.destroy());
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(path, () => resolveListen());
	});
	return server;
}

export function closeServer(server: Server): Promise<void> {
	return new Promise((resolveClose) => server.close(() => resolveClose()));
}

export async function exitedPid(): Promise<number> {
	return new Promise((resolvePid, reject) => {
		const child = execFile(process.execPath, ["-e", ""], (error) => {
			if (error) reject(error);
			else if (child.pid === undefined) reject(new Error("no pid"));
			else resolvePid(child.pid);
		});
	});
}

export function gate(outcome: "resolve" | "reject" = "resolve") {
	let enter: () => void = () => {};
	let open: () => void = () => {};
	const entered = new Promise<void>((resolveEntered) => {
		enter = resolveEntered;
	});
	const opened = new Promise<void>((resolveOpened) => {
		open = resolveOpened;
	});
	const hook = async (): Promise<void> => {
		enter();
		await opened;
		if (outcome === "reject") throw new Error("gate released the paused ensure");
	};
	return { hook, entered, open };
}

/** Resolves once `path` exists: subscribes to its directory first, then checks, so no event is missed. */
export async function fileAppears(path: string, timeoutMs = 60_000): Promise<void> {
	const watcher = watch(dirname(path));
	try {
		const appeared = new Promise<void>((resolveAppeared, reject) => {
			const timer = setTimeout(() => reject(new Error(`${path} did not appear in ${timeoutMs}ms`)), timeoutMs);
			const check = (): void => {
				stat(path).then(
					() => {
						clearTimeout(timer);
						resolveAppeared();
					},
					() => undefined,
				);
			};
			watcher.on("change", (_event, name) => {
				if (String(name) === basename(path)) check();
			});
			check();
		});
		await appeared;
	} finally {
		watcher.close();
	}
}

export async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value)}\n`);
}

export function siblingPath(socket: string, suffix: string): string {
	return join(dirname(socket), `${basename(socket)}${suffix}`);
}
