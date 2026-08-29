import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionRegistryCapacityError, TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { TerminalSessionBundle } from "../../src/core/extensions/builtin/terminal/session-bundle.ts";

describe("terminal manager capacity", () => {
	it("reserves one slot before asynchronously creating a terminal", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-terminal-capacity-")));
		const manager = new TerminalManager({ maxSessions: 1 });
		const command = process.execPath;
		const options = {
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			cols: 80,
			rows: 24,
			cwd: root,
			env: { ...process.env, SENPI_PTY_FORCE_PIPE: "1" },
		};

		try {
			const results = await Promise.allSettled([manager.create(command, options), manager.create(command, options)]);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			const rejection = results.find((result) => result.status === "rejected");
			expect(rejection).toEqual(
				expect.objectContaining({
					reason: expect.any(SessionRegistryCapacityError),
				}),
			);
			expect(manager.activeSize).toBe(1);
		} finally {
			await manager.teardown();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("shares pending terminal reservations with native file admission", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-shared-terminal-capacity-")));
		const bundle = new TerminalSessionBundle({ maxSessions: 1 });
		const command = process.execPath;

		try {
			const terminal = bundle.manager.create(command, {
				command: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000)"],
				cols: 80,
				rows: 24,
				cwd: root,
				env: { ...process.env, SENPI_PTY_FORCE_PIPE: "1" },
			});
			const file = bundle.monitors.registerFile({
				description: "competing file watch",
				path: join(root, "artifact.json"),
				event: "create",
				timeoutMs: 5000,
			});
			const [terminalResult, fileResult] = await Promise.allSettled([terminal, file]);
			expect(terminalResult.status).toBe("fulfilled");
			expect(fileResult).toEqual(
				expect.objectContaining({
					status: "rejected",
				}),
			);
			expect(bundle.manager.activeSize).toBe(1);
			expect(bundle.monitors.fileCount).toBe(0);
		} finally {
			await bundle.teardown();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects terminal creation racing with teardown without leaking a session", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-terminal-teardown-race-")));
		const manager = new TerminalManager();
		const command = process.execPath;

		try {
			const creating = manager.create(command, {
				command: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000)"],
				cols: 80,
				rows: 24,
				cwd: root,
				env: { ...process.env, SENPI_PTY_FORCE_PIPE: "1" },
			});
			await manager.teardown();
			await expect(creating).rejects.toThrow("shutting down");
			expect(manager.activeSize).toBe(0);
			expect(manager.size).toBe(0);
		} finally {
			await manager.teardown();
			await rm(root, { recursive: true, force: true });
		}
	});
});
