import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/limits.ts";
import { createLocalMachineOps } from "../src/local.ts";
import { createInProcessHolderLink } from "../src/process/in-process-holder.ts";
import { ScopeRegistry, SCOPE_ENV } from "../src/process/scopes.ts";
import type { MachineOps, OpContext } from "../src/types.ts";

// senpi#5603 review: a scope token is recorded only when the caller configures a registry (a stateDir); the registry
// survives its directory being removed; a recorded group is signalled only while its leader is the process it started.

const posix = process.platform !== "win32";

function ctx(): OpContext {
	return {
		scope: { id: "scope-registry-test" },
		principal: { kind: "local-session", id: "scope-registry-test" },
		signal: new AbortController().signal,
		limits: DEFAULT_LIMITS,
		policy: {},
	};
}

async function envKeys(ops: MachineOps): Promise<string[]> {
	const result = await ops.process.exec(
		{ command: "env", envMode: "exact", env: { PATH: process.env.PATH, MARKER: "1" } },
		ctx(),
	);
	expect(result.exitCode).toBe(0);
	return Buffer.from(result.stdout)
		.toString("utf8")
		.split("\n")
		.filter((line) => line.includes("="))
		.map((line) => line.slice(0, line.indexOf("=")))
		.sort();
}

function processGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

describe.runIf(posix)("scope registry (senpi#5603)", () => {
	let base: string;
	const children: ChildProcess[] = [];

	beforeEach(async () => {
		base = await realpath(await mkdtemp(join(tmpdir(), "machine-ops-scopes-")));
	});

	afterEach(async () => {
		// Only children this file spawned are signalled.
		for (const child of children.splice(0)) {
			if (child.exitCode === null && child.signalCode === null) {
				const exited = new Promise((resolve) => child.once("exit", resolve));
				child.kill("SIGKILL");
				await exited;
			}
		}
		await rm(base, { recursive: true, force: true });
	});

	it("without a stateDir an exec records no token, writes nothing and adds no scope variable", async () => {
		const ops = createLocalMachineOps({ holder: createInProcessHolderLink() });
		const result = await ops.process.exec({ command: "env", cwd: base }, ctx());
		expect(result.exitCode).toBe(0);
		expect(Buffer.from(result.stdout).toString()).not.toContain(`${SCOPE_ENV}=`);
		expect(result.scopeToken).toBeUndefined();
		expect(await readdir(base)).toEqual([]);
	});

	it("a registry adds exactly SENPI_MACHINE_SCOPE to the child environment", async () => {
		const without = await envKeys(createLocalMachineOps({ holder: createInProcessHolderLink() }));
		const withRegistry = await envKeys(
			createLocalMachineOps({ stateDir: join(base, "state"), holder: createInProcessHolderLink() }),
		);
		expect(SCOPE_ENV).toBe("SENPI_MACHINE_SCOPE");
		expect(withRegistry).toEqual([...without, SCOPE_ENV].sort());
	});

	it("an exec still records its token after the scopes dir was removed mid-process", async () => {
		const stateDir = join(base, "state");
		const ops = createLocalMachineOps({ stateDir, holder: createInProcessHolderLink() });
		expect((await ops.process.exec({ command: "true" }, ctx())).exitCode).toBe(0);
		await rm(join(stateDir, "machine"), { recursive: true, force: true });
		const again = await ops.process.exec(
			{ command: `cat "${join(stateDir, "machine", "scopes")}/$SENPI_MACHINE_SCOPE.json"` },
			ctx(),
		);
		expect(again.exitCode).toBe(0);
		expect(JSON.parse(Buffer.from(again.stdout).toString()).token).toBe(again.scopeToken);
	});

	async function ownGroupLeader(): Promise<ChildProcess & { pid: number }> {
		const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		children.push(child);
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		return child as ChildProcess & { pid: number };
	}

	it("does not signal a recorded group whose leader start time no longer matches", async () => {
		const child = await ownGroupLeader();
		let reads = 0;
		// The first read is the record at attach; later reads see a different process behind the same pid.
		const registry = new ScopeRegistry(join(base, "state"), () => {}, {
			startTimeOf: async () => (reads++ === 0 ? "start-recorded" : "start-of-a-reused-pid"),
		});
		registry.attach("token-a", child.pid);
		await registry.sweep(["token-a"]);
		expect(processGone(child.pid)).toBe(false);
		expect(child.signalCode).toBeNull();
		expect(reads).toBeGreaterThan(1);
	});

	it("sweeps a recorded group whose leader start time matches", async () => {
		const child = await ownGroupLeader();
		const exited = new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
		const registry = new ScopeRegistry(join(base, "state"), () => {});
		registry.attach("token-b", child.pid);
		await registry.sweep(["token-b"]);
		expect(await exited).toBe("SIGHUP");
	});
});
