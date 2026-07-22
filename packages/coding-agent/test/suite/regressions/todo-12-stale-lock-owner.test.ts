import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegistry } from "../../../src/modes/app-server/rpc/registry.ts";
import { registerAppServerModelMethods } from "../../../src/modes/app-server/server/models.ts";

const lockReadRace = vi.hoisted(
	(): { lockPath: string | undefined; replacementPath: string | undefined; replaced: boolean } => ({
		lockPath: undefined,
		replacementPath: undefined,
		replaced: false,
	}),
);

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rmdir: async (...args: Parameters<typeof actual.rmdir>) => {
			const path = args[0];
			if (
				!lockReadRace.replaced &&
				typeof path === "string" &&
				lockReadRace.lockPath !== undefined &&
				lockReadRace.replacementPath !== undefined &&
				path === lockReadRace.lockPath
			) {
				await actual.rename(lockReadRace.replacementPath, lockReadRace.lockPath);
				lockReadRace.replaced = true;
			}
			return actual.rmdir(...args);
		},
	};
});

afterEach(() => {
	lockReadRace.lockPath = undefined;
	lockReadRace.replacementPath = undefined;
	lockReadRace.replaced = false;
});

describe("todo-12 stale installation-id lock ownership", () => {
	it("preserves a replacement owner when the stale inode changes after metadata is read", async () => {
		// Given: a dead-owner lock and a live replacement ready for an atomic path swap after the stale read.
		const agentDir = await mkdtemp(join(tmpdir(), "senpi-stale-lock-owner-"));
		const appServerDir = join(agentDir, "app-server");
		const lockPath = join(appServerDir, "installation-id.lock");
		const replacementPath = `${lockPath}.replacement`;
		const liveOwner = `${JSON.stringify({ ownerToken: "live-owner", pid: process.pid, createdAtMs: Date.now() })}\n`;
		try {
			await mkdir(appServerDir, { recursive: true });
			await mkdir(lockPath);
			await writeFile(
				join(lockPath, "owner-dead-owner.json"),
				`${JSON.stringify({ ownerToken: "dead-owner", pid: 999_999_999, createdAtMs: 1 })}\n`,
				"utf8",
			);
			await mkdir(replacementPath);
			await writeFile(join(replacementPath, "owner-live-owner.json"), liveOwner, "utf8");
			lockReadRace.lockPath = lockPath;
			lockReadRace.replacementPath = replacementPath;
			const registry = createRegistry();
			registerAppServerModelMethods(registry, { agentDir });

			// When: status/read encounters the stale lock while the rmdir boundary swaps in the live owner.
			const response = await registry.dispatch(
				{ initialized: true, capabilities: { experimentalApi: true } },
				{ id: 1, method: "remoteControl/status/read" },
			);

			// Then: live contention times out without deleting the replacement owner or leaving claim files.
			expect(lockReadRace.replaced).toBe(true);
			await expect(readFile(join(lockPath, "owner-live-owner.json"), "utf8")).resolves.toBe(liveOwner);
			expect(response).toMatchObject({ id: 1, error: { code: -32603 } });
			expect((await readdir(appServerDir)).filter((name) => name.includes(".claim-"))).toEqual([]);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});
