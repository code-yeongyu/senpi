import * as fs from "node:fs/promises";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAgentDir } from "../../../src/config.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { nodeCompactStorageIo } from "../../../src/modes/rpc/compact-storage-io.ts";
import { RecoveryStorageHealth } from "../../../src/modes/rpc/compact-storage-health.ts";
import { RecoveryCheckpoints } from "../../../src/modes/rpc/compact-recovery-state.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";

vi.mock("node:fs/promises", { spy: true });

// #4272 S14, RULING-84: a real durable recovery, not a freeze, advances the persisted health revision.
let base = "";
beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "s14-health-"));
});
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(base, { recursive: true, force: true });
});

async function repairWrite() {
	const file = await open(join(base, "repaired"), "w", 0o600);
	try {
		await file.writeFile("storage repaired");
		await file.sync();
	} finally {
		await file.close();
	}
}

it("S14 R84 disk full then space freed advances health with no accepted-source progress and survives restart", async () => {
	const health = new RecoveryStorageHealth(base);
	const initial = await health.revision();
	health.unavailable();
	await expect(
		health.recover(async () => {
			throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
		}),
	).rejects.toMatchObject({ code: "ENOSPC" });
	expect(await health.revision()).toBe(initial);
	const recovered = await health.recover(repairWrite);
	expect(BigInt(recovered)).toBeGreaterThan(BigInt(initial));
	const restarted = new RecoveryStorageHealth(base);
	expect(await restarted.revision()).toBe(recovered);
	restarted.unavailable();
	expect(BigInt(await restarted.recover(repairWrite))).toBeGreaterThan(BigInt(recovered));
});

it("S14 R84 a freeze and a successful write without a prior failure never bump health", async () => {
	const health = new RecoveryStorageHealth(base);
	const lane = new SessionAcceptanceLane({ dir: base, health });
	lane.bootstrap({ transcript: [] });
	const checkpoints = new RecoveryCheckpoints();
	const route = {
		socketEpoch: "peer",
		sessionId: "session",
		admissionId: "admission",
		routeKind: "ordinary",
		peer: "peer",
	} as const;
	const initial = await health.revision();
	const cut = checkpoints.freeze(route, lane);
	expect(cut.ok).toBe(true);
	expect(await health.revision()).toBe(initial);
	expect(await health.recover(repairWrite)).toBe(initial);
	if (cut.ok) checkpoints.release(cut.value.token);
	lane.retire("close");
	await lane.idle();
});

it("S14 R84 independent recovering owners serialize durable revisions instead of reissuing a value", async () => {
	const first = new RecoveryStorageHealth(base);
	const second = new RecoveryStorageHealth(base);
	first.unavailable();
	second.unavailable();
	const revisions = await Promise.all([first.recover(repairWrite), second.recover(repairWrite)]);
	expect(new Set(revisions).size).toBe(2);
	expect(await new RecoveryStorageHealth(base).revision()).toBe(
		revisions.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b)),
	);
});

// #4272 S14 L3: damaged health metadata is repairable without writing through a substituted symlink.
it.each(["corrupt", "symlink"] as const)("repairs a %s revision atomically and can advance again", async (damage) => {
	const health = new RecoveryStorageHealth(base);
	await health.revision();
	const dir = join(base, `.senpi-recovery-health-${process.getuid?.() ?? "user"}`);
	const revision = join(dir, "revision");
	const outside = join(base, "outside");
	await writeFile(outside, "untouched");
	if (damage === "symlink") await symlink(outside, revision);
	else await writeFile(revision, "not a revision");

	const repaired = await health.revision();
	health.unavailable();
	const advanced = await health.recover(repairWrite);

	expect(BigInt(advanced)).toBeGreaterThan(BigInt(repaired));
	expect((await lstat(revision)).isFile()).toBe(true);
	expect((await lstat(revision)).mode & 0o777).toBe(0o600);
	expect(await readFile(outside, "utf8")).toBe("untouched");
	expect(await new RecoveryStorageHealth(base).revision()).toBe(advanced);
});

it("places the default health store under the agent directory and initializes it only once", async () => {
	vi.stubEnv("SENPI_CODING_AGENT_DIR", undefined);
	vi.stubEnv("HOME", base);
	const mkdir = vi.spyOn(fs, "mkdir");
	const health = new RecoveryStorageHealth(getAgentDir());
	const expected = `.senpi-recovery-health-${process.getuid?.() ?? "user"}`;
	expect(mkdir).not.toHaveBeenCalled();

	await Promise.all([health.revision(), health.revision()]);
	await health.revision();
	health.unavailable();
	await health.recover(repairWrite);

	expect(await readdir(getAgentDir())).toContain(expected);
	expect(await readdir(base)).not.toContain(expected);
	expect(mkdir).toHaveBeenCalledExactlyOnceWith(join(getAgentDir(), expected), { mode: 0o700, recursive: true });
});

// #4272 S14: a host's captured directory wins over session-time environment discovery.
it("keeps lane health under the supplied host agent directory", async () => {
	const agentDir = join(base, "host-agent");
	vi.stubEnv("SENPI_CODING_AGENT_DIR", join(base, "other-agent"));
	const lane = new SessionAcceptanceLane({ dir: base }, undefined, agentDir);
	lane.bootstrap({ transcript: [] });
	const root = lane.freeze();
	try {
		expect(await lane.cutStorage(root, (store) => store.health.revision())).toBe("0");
		expect(await readdir(agentDir)).toContain(`.senpi-recovery-health-${process.getuid?.() ?? "user"}`);
	} finally {
		lane.release(root);
		lane.retire("close");
		await lane.idle();
	}
});

// #4272 S14 LOW-1: constructors never perform I/O or throw an ownership refusal, and a failed setup is retryable.
it.each(["revision", "recover"] as const)("defers ownership refusal to %s and retries after repair", async (method) => {
	const outside = join(base, "outside");
	await mkdir(outside, { mode: 0o700 });
	const dir = join(base, `.senpi-recovery-health-${process.getuid?.() ?? "user"}`);
	await symlink(outside, dir);
	const health = new RecoveryStorageHealth(base);
	const operation = vi.fn(repairWrite);

	await expect(method === "revision" ? health.revision() : health.recover(operation)).rejects.toMatchObject({
		reason: "ownership",
	});
	expect(operation).not.toHaveBeenCalled();
	await rm(dir);
	expect(await health.revision()).toBe("0");
	expect((await lstat(dir)).isDirectory()).toBe(true);
});

// #4272 S14 L5: cleanup/read errors are not proof that storage writes became unavailable.
it.each(["mkdir", "lstat"] as const)(
	"S14 review carry preserves %s setup errors and allows retry",
	async (operation) => {
		for (const code of ["ENOSPC", "EACCES", "EROFS"]) {
			const failure = Object.assign(new Error(code), { code });
			const health = new RecoveryStorageHealth(base);
			vi.spyOn(fs, operation).mockRejectedValueOnce(failure);
			await expect(health.revision()).rejects.toBe(failure);
			expect(await health.revision()).toBe("0");
			vi.restoreAllMocks();
		}
	},
);

it.each(["reclaim", "leaf_read", "page_write"] as const)(
	"only a real write failure advances health after %s fails and a later write succeeds",
	async (operation) => {
		vi.useFakeTimers();
		const health = new RecoveryStorageHealth(base);
		const initial = await health.revision();
		let failWrite = operation === "page_write";
		const store = new CompactContentStore({
			dir: join(base, "senpi-current-failure"),
			health,
			io: {
				...nodeCompactStorageIo,
				writeFile: async (path, bytes) => {
					if (failWrite) {
						failWrite = false;
						throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
					}
					await nodeCompactStorageIo.writeFile(path, bytes);
				},
				readFile: async () => {
					throw Object.assign(new Error("read denied"), { code: "EACCES" });
				},
				unlink: async () => {
					throw Object.assign(new Error("unlink denied"), { code: "EACCES" });
				},
			},
		});
		try {
			const path = await store.writeFile(Buffer.from("before"), "page_write", 0);
			if (operation === "reclaim" && path) store.discard(path, 6);
			if (operation === "leaf_read" && path)
				await expect(store.readFile(path, 6, "leaf_read")).rejects.toThrow("read denied");
			await store.idle();
			expect(store.status().failures.some((failure) => failure.operation === operation)).toBe(true);

			await store.writeFile(Buffer.from("after"), "page_write", 0);

			expect(await health.revision()).toBe(operation === "page_write" ? "1" : initial);
		} finally {
			await store.retire();
		}
	},
);
