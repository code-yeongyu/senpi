// senpi#3566 todo 4 (review HIGH 3, LOW 1, delta LOW 1): a session directory too deep for sun_path still starts its child
// (and a symlink planted at its fallback directory is never used or changed, nor does it block the start), a start
// that fails for any reason never leaves the client "spawning", and an unsubscribed channel listener hears nothing.
import { ChildProcess } from "node:child_process";
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_SOCKET_PATH_BYTES } from "../socket-ownership.ts";
import { connectChannel, openChannelListener } from "./channel.ts";
import { ToolChildClient } from "./client.ts";
import { channelSocketPath, fallbackSocketRoot } from "./socket-root.ts";

const resolver = pathToFileURL(resolve(import.meta.dirname, "../../../experimental/source-resolver.ts")).href;
const roleEntry = resolve(import.meta.dirname, "../../../tool-child-main.ts");
const command = { command: process.execPath, args: ["--import", resolver, roleEntry] };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scratch(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

describe.skipIf(process.platform === "win32")("tool child start", () => {
	it("puts the socket of a too-deep session directory under a short private directory, and the child starts", async () => {
		const base = await scratch("tcs-");
		const deep = join(base, "x".repeat(60), "y".repeat(60), "tool-children", "0123456789abcdef0123456789abcdef0123");
		const socket = await channelSocketPath(deep, 1);
		expect(Buffer.byteLength(join(deep, "c-1.sock"))).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);
		expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
		expect(socket.startsWith("/tmp/senpi-tc-")).toBe(true);
		expect((await lstat(join(socket, ".."))).mode & 0o077).toBe(0);
		const instance = new ToolChildClient({ dir: deep, cwd: base, command, env: process.env });
		cleanups.push(() => instance.close());
		await instance.start();
		expect(await instance.ping()).toBeGreaterThan(0);
	}, 30_000);

	it("never uses or changes a symlink planted at the fallback directory, and still starts the child elsewhere", async () => {
		const base = await scratch("tcs-");
		const deep = join(base, "z".repeat(60), "w".repeat(60), "tool-children", "0123456789abcdef0123456789abcdef0123");
		const target = await scratch("tcs-target-");
		await chmod(target, 0o755);
		const root = fallbackSocketRoot(deep);
		await symlink(target, root);
		cleanups.push(() => rm(root, { force: true }));
		const socket = await channelSocketPath(deep, 1);
		const socketDir = join(socket, "..");
		cleanups.push(() => rm(socketDir, { recursive: true, force: true }));
		expect(socketDir.startsWith(`${root}-`)).toBe(true);
		expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
		const stat = await lstat(socketDir);
		expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
		expect(stat.mode & 0o077).toBe(0);
		expect((await lstat(target)).mode & 0o777).toBe(0o755);
		const instance = new ToolChildClient({ dir: deep, cwd: base, command, env: process.env });
		cleanups.push(() => instance.close());
		await instance.start();
		expect(await instance.ping()).toBeGreaterThan(0);
		expect((await lstat(target)).mode & 0o777).toBe(0o755);
	}, 30_000);

	it("fails a start whose command cannot spawn typed, and is not left spawning", async () => {
		const dir = await scratch("tcs-");
		const instance = new ToolChildClient({ dir, cwd: dir, command: { command: "/nonexistent/senpi", args: [] } });
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(instance.start()).rejects.toMatchObject({ code: "tool_child_bootstrap_failed" });
			expect(instance.state).toBe("dead");
		}
	}, 30_000);

	it("never signals anything for a child that failed to spawn", async () => {
		// Node 26 sends `kill()` on a child with no pid to the caller's own process group; the spy keeps it from running.
		const kill = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(() => false);
		cleanups.push(async () => kill.mockRestore());
		const dir = await scratch("tcs-");
		const instance = new ToolChildClient({ dir, cwd: dir, command: { command: "/nonexistent/senpi", args: [] } });
		await expect(instance.start()).rejects.toMatchObject({ code: "tool_child_bootstrap_failed" });
		expect(kill).not.toHaveBeenCalled();
	}, 30_000);

	it("fails a start whose listener cannot open typed, and is not left spawning", async () => {
		const base = await scratch("tcs-");
		const file = join(base, "not-a-dir");
		await writeFile(file, "");
		const instance = new ToolChildClient({ dir: join(file, "child"), cwd: base, command });
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(instance.start()).rejects.toMatchObject({ code: "tool_child_bootstrap_failed" });
			expect(instance.state).toBe("dead");
		}
	}, 30_000);

	it("stops delivering to a listener once it unsubscribed", async () => {
		const dir = await scratch("tcs-");
		const listener = await openChannelListener({ dir, generation: 1 });
		const client = await connectChannel(listener.env);
		const server = await listener.accepted;
		await listener.close();
		cleanups.push(async () => {
			client.close();
			server.close();
		});
		const heard: string[] = [];
		const unsubscribe = server.onMessage((message) => heard.push(message.type));
		client.send({ type: "pong", seq: 1 });
		await new Promise<void>((resolveHeard) => {
			const stop = server.onMessage(() => {
				stop();
				resolveHeard();
			});
		});
		unsubscribe();
		client.send({ type: "pong", seq: 2 });
		await new Promise<void>((resolveHeard) => {
			const stop = server.onMessage(() => {
				stop();
				resolveHeard();
			});
		});
		expect(heard).toEqual(["pong"]);
	}, 30_000);
});
