/**
 * Fixtures for the `host gc` suite: endpoint states built on disk without a host, sockets that
 * refuse or answer on demand, and a gate that holds a critical section open until the test says so.
 *
 * A REFUSING socket needs a real socket file with no listener. Closing a listening server would not
 * leave one - libuv unlinks the path it bound - so `refusingSocket` moves the entry aside for the
 * close and back afterwards, exactly as `shieldSocketDuringClose` does in production.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { basename, dirname, join } from "node:path";
import { createDaemonDirectories, createHostDaemonPaths } from "../../src/modes/rpc/host-daemon-paths.ts";
import { hostSpawnEnv } from "../helpers/rpc-host-spawn-env.ts";

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

/**
 * A process that has exited but is not reaped yet (a zombie), held by a parent that never waits on it -
 * what a SIGKILLed supervisor or host child is until its parent's loop (or init) reaps it (senpi#4119).
 * The parent learns of the exit from the child's end of a pipe closing, then `ps` must report state Z.
 */
export async function heldZombie(
	timeoutMs = 10_000,
): Promise<{ pid: number; processStartTime: string; release: () => void }> {
	const script =
		'pipe(R,W); my $p = fork(); if (!$p) { close R; exit 0 } close W; my $x = <R>; $| = 1; print "$p\\n"; sleep 600';
	const parent = spawn("perl", ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
	const release = (): void => {
		parent.kill("SIGKILL");
	};
	try {
		const pid = await new Promise<number>((resolvePid, reject) => {
			let out = "";
			parent.stdout.on("data", (chunk: Buffer) => {
				out += chunk.toString();
				if (out.includes("\n")) resolvePid(Number(out.trim()));
			});
			parent.once("error", reject);
			parent.once("exit", () => reject(new Error("zombie parent exited early")));
		});
		const deadline = Date.now() + timeoutMs;
		while (processState(pid) !== "Z") {
			if (Date.now() > deadline) throw new Error(`child ${pid} never reached state Z`);
			await new Promise((resolveTick) => setTimeout(resolveTick, 25));
		}
		// What its pidfile recorded while it ran: a zombie keeps its start time.
		const processStartTime = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			env: { ...hostSpawnEnv(), LC_ALL: "C", LANG: "C" },
		}).trim();
		if (!processStartTime) throw new Error(`no start time readable for zombie ${pid}`);
		return { pid, processStartTime, release };
	} catch (error) {
		release();
		throw error;
	}
}

function processState(pid: number): string {
	try {
		return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
			.trim()
			.charAt(0);
	} catch {
		return "";
	}
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
