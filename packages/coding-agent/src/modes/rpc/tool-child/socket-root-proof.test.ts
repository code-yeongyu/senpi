// senpi#3694: nothing is removed through a socket root before it is proven ours, nothing already at the secret's name is
// ever followed or overwritten, no secret material outlives a failed claim, its withdrawal never reaches another
// directory's file, and a fallback root another user takes during the claim never blocks the start.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readdir, readFile, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSocketRootWindow, socketRootWindow } from "../../../../test/helpers/socket-root-window.ts";
import { openChannelListener } from "./channel.ts";
import { fallbackSocketRoot } from "./socket-root.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const { withSocketRootWindow } = await import("../../../../test/helpers/socket-root-window.ts");
	return withSocketRootWindow(await importOriginal<typeof import("node:fs/promises")>());
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	resetSocketRootWindow();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scratch(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function deepDir(): Promise<string> {
	const base = await scratch("tcproof-");
	return join(base, "c".repeat(60), "d".repeat(60), "tool-children", "0123456789abcdef0123456789abcdef0123");
}

function takeRootAs(target: string): (root: string) => Promise<void> {
	return async (root) => {
		await rmdir(root);
		await symlink(target, root);
		cleanups.push(() => rm(root, { force: true }));
	};
}

describe.skipIf(process.platform === "win32")("tool-child socket root proof", () => {
	it("removes a stale socket only after the secret is written and the root proven", async () => {
		const dir = await scratch("tcproof-primary-");
		const listener = await openChannelListener({ dir, generation: 1 });
		await listener.close();
		expect(socketRootWindow.order.slice(0, 2)).toEqual(["secret", "rm-socket"]);
	});

	it("never writes through an entry planted at the secret's name in a taken root", async () => {
		const dir = await deepDir();
		const root = fallbackSocketRoot(dir);
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const victim = join(await scratch("tcproof-victim-"), "authorized_keys");
		await writeFile(victim, "keep me");
		await chmod(victim, 0o644);
		const taken = await scratch("tcproof-taken-");
		await symlink(victim, join(taken, "c-1.sock.secret"));
		socketRootWindow.windows = [takeRootAs(taken)];
		const listener = await openChannelListener({ dir, generation: 1 });
		cleanups.push(() => rm(dirname(listener.env.SENPI_TOOL_CHILD_CHANNEL), { recursive: true, force: true }));
		expect(await readFile(victim, "utf8")).toBe("keep me");
		expect((await lstat(victim)).mode & 0o777).toBe(0o644);
		expect(dirname(listener.env.SENPI_TOOL_CHILD_CHANNEL).startsWith(`${root}-`)).toBe(true);
		await listener.close();
	});

	it("leaves no secret material behind when the retry's root is taken too, and refuses the start", async () => {
		const dir = await deepDir();
		const root = fallbackSocketRoot(dir);
		const foreign = await scratch("tcproof-foreign-");
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		socketRootWindow.windows = [takeRootAs(foreign), takeRootAs(foreign)];
		await expect(openChannelListener({ dir, generation: 1 })).rejects.toThrow("socket_dir_unsafe");
		// The taken root cannot be proven ours, so nothing is unlinked through it: the secret is only emptied in place.
		for (const name of await readdir(foreign)) expect(await readFile(join(foreign, name))).toHaveLength(0);
	});

	it("starts under a fresh private directory when the secret write into a taken root is denied", async () => {
		const dir = await deepDir();
		const root = fallbackSocketRoot(dir);
		const denied = await scratch("tcproof-denied-");
		await chmod(denied, 0o500);
		cleanups.push(() => chmod(denied, 0o700));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		socketRootWindow.windows = [takeRootAs(denied)];
		const listener = await openChannelListener({ dir, generation: 1 });
		const socketRoot = dirname(listener.env.SENPI_TOOL_CHILD_CHANNEL);
		cleanups.push(() => rm(socketRoot, { recursive: true, force: true }));
		expect(socketRoot.startsWith(`${root}-`)).toBe(true);
		expect(existsSync(listener.env.SENPI_TOOL_CHILD_CHANNEL_SECRET)).toBe(true);
		await listener.close();
	});

	it("never removes a file through a root that is swapped while it is still empty", async () => {
		const dir = await deepDir();
		const root = fallbackSocketRoot(dir);
		const victim = await scratch("tcproof-victim-");
		await writeFile(join(victim, "c-1.sock"), "not ours");
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		let swapped = false;
		socketRootWindow.onSocketRemoval = async (socketPath) => {
			const socketRoot = dirname(socketPath);
			if (swapped || socketRoot !== root || (await readdir(socketRoot)).length > 0) return;
			swapped = true;
			await takeRootAs(victim)(socketRoot);
		};
		const listener = await openChannelListener({ dir, generation: 1 }).catch(() => undefined);
		if (listener !== undefined) {
			cleanups.push(() => rm(dirname(listener.env.SENPI_TOOL_CHILD_CHANNEL), { recursive: true, force: true }));
			await listener.close();
		}
		expect(socketRootWindow.order).toContain("rm-socket");
		expect(await readdir(victim)).toEqual(["c-1.sock"]);
	});

	it("never blocks on a FIFO planted at the secret's name, and warns what it left there", async () => {
		const dir = await deepDir();
		const root = fallbackSocketRoot(dir);
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		cleanups.push(async () => warn.mockRestore());
		socketRootWindow.onSocketRemoval = async (socketPath) => {
			if (dirname(socketPath) !== root) return;
			// Whoever holds the root replaces our secret with a FIFO nobody ever reads, then the claim fails.
			await rm(`${socketPath}.secret`);
			execFileSync("mkfifo", [`${socketPath}.secret`]);
			throw new Error("claim fails after the secret exists");
		};
		await expect(openChannelListener({ dir, generation: 1 })).rejects.toThrow("claim fails after the secret exists");
		const detail = warn.mock.calls
			.map(([, options]) => options)
			.filter((options) => Reflect.get(Object(options), "code") === "SENPI_TOOL_CHILD_SECRET_WITHDRAWAL")
			.map((options) => JSON.parse(String(Reflect.get(Object(options), "detail"))));
		expect(detail).toEqual([{ path: join(root, "c-1.sock.secret"), state: "unknown", reason: "ENXIO" }]);
	}, 10_000);

	it("never withdraws a secret through a root swapped after the secret was written", async () => {
		const dir = await deepDir();
		const root = fallbackSocketRoot(dir);
		const moved = `${root}-moved`;
		const victim = await scratch("tcproof-victim-");
		await writeFile(join(victim, "c-1.sock.secret"), "another session's secret");
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		cleanups.push(() => rm(moved, { recursive: true, force: true }));
		socketRootWindow.onSocketRemoval = async (socketPath) => {
			if (dirname(socketPath) !== root) return;
			await rename(root, moved);
			await symlink(victim, root);
			throw new Error("claim fails after the secret exists");
		};
		await expect(openChannelListener({ dir, generation: 1 })).rejects.toThrow("claim fails after the secret exists");
		expect(await readFile(join(victim, "c-1.sock.secret"), "utf8")).toBe("another session's secret");
	});
});
