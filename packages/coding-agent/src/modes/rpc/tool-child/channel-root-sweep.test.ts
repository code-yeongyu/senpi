// senpi#3685: the short fallback socket root is shared by every listener of a session's tool-child dir. It survives
// while any listener holds it, is swept when the last one closes, and a sweep that lands between a sibling's claim
// and its secret write never leaves that sibling's socket or secret material in a directory that is not its own.
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, rm, rmdir, symlink } from "node:fs/promises";
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

async function deepDir(): Promise<string> {
	const base = await mkdtemp(join(tmpdir(), "tcsweep-"));
	cleanups.push(() => rm(base, { recursive: true, force: true }));
	return join(base, "a".repeat(60), "b".repeat(60), "tool-children", "0123456789abcdef0123456789abcdef0123");
}

describe.skipIf(process.platform === "win32")("tool-child fallback socket root sweep", () => {
	it("keeps the root while a sibling listener holds it and removes it after the last close", async () => {
		const dir = await deepDir();
		const root = fallbackSocketRoot(dir);
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const first = await openChannelListener({ dir, generation: 1 });
		const second = await openChannelListener({ dir, generation: 2 });
		expect(dirname(first.env.SENPI_TOOL_CHILD_CHANNEL)).toBe(root);
		expect(dirname(second.env.SENPI_TOOL_CHILD_CHANNEL)).toBe(root);
		await first.close();
		expect(existsSync(root)).toBe(true);
		await second.close();
		expect(existsSync(root)).toBe(false);
	});

	it("moves to a private directory of its own when the root is swept and replaced before the secret is written", async () => {
		const dir = await deepDir();
		const root = fallbackSocketRoot(dir);
		const foreign = await mkdtemp(join(tmpdir(), "tcsweep-foreign-"));
		cleanups.push(() => rm(foreign, { recursive: true, force: true }));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		// A sibling's sweep removes the claimed, still-empty root, and something else takes the name at once.
		socketRootWindow.windows = [
			async () => {
				await rmdir(root);
				await symlink(foreign, root);
			},
		];
		const listener = await openChannelListener({ dir, generation: 1 });
		const socketRoot = dirname(listener.env.SENPI_TOOL_CHILD_CHANNEL);
		cleanups.push(() => rm(socketRoot, { recursive: true, force: true }));
		expect(socketRoot.startsWith(`${root}-`)).toBe(true);
		expect(dirname(listener.env.SENPI_TOOL_CHILD_CHANNEL_SECRET)).toBe(socketRoot);
		const stat = await lstat(socketRoot);
		expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
		expect(stat.mode & 0o077).toBe(0);
		// The taken root cannot be proven ours, so nothing is unlinked through it: the secret is only emptied in place.
		for (const name of await readdir(foreign)) expect(await readFile(join(foreign, name))).toHaveLength(0);
		expect((await lstat(root)).isSymbolicLink()).toBe(true);
		await listener.close();
		expect(existsSync(socketRoot)).toBe(false);
	});

	it("keeps a swept root of its own private once the secret write recreated it", async () => {
		const dir = await deepDir();
		const root = fallbackSocketRoot(dir);
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		socketRootWindow.windows = [
			async () => {
				await rmdir(root);
			},
		];
		const listener = await openChannelListener({ dir, generation: 1 });
		expect(dirname(listener.env.SENPI_TOOL_CHILD_CHANNEL)).toBe(root);
		expect((await lstat(root)).mode & 0o077).toBe(0);
		await listener.close();
	});
});
