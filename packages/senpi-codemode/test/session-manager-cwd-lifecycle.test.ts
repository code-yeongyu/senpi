import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeServerHandle } from "../src/bridge/http-server.ts";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import type * as SessionCwd from "../src/extension/session-cwd.ts";
import { type CodemodeSessionManager, createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";
import type { EvalKernel } from "../src/tool/types.ts";
import { FakeKernel } from "./eval/fakes.ts";

// The session directory is checked before a kernel is created and again once it is stored. These
// cases hold the kernel start (and, for the dispose race, the second check) open so a directory
// deletion or a dispose lands inside that window deterministically. The check itself stays real.
interface CwdLifecycleHarness {
	startKernel: () => Promise<EvalKernel>;
	checkCwd: (cwd: string, real: (cwd: string) => Promise<void>) => Promise<void>;
}

const harness = vi.hoisted(
	(): CwdLifecycleHarness => ({
		startKernel: async () => {
			throw new Error("kernel start was not configured");
		},
		checkCwd: async (cwd, real) => await real(cwd),
	}),
);

vi.mock("../src/bridge/http-server.ts", () => ({
	startBridgeServer: async (): Promise<BridgeServerHandle> => ({
		port: 31337,
		token: "test-token",
		close: async () => {},
	}),
}));

vi.mock("../src/kernels/py/kernel.ts", () => ({
	PythonKernel: { start: async (): Promise<EvalKernel> => await harness.startKernel() },
}));

vi.mock("../src/extension/session-cwd.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof SessionCwd>();
	return {
		...actual,
		assertSessionCwdAvailable: async (cwd: string): Promise<void> =>
			await harness.checkCwd(cwd, actual.assertSessionCwdAvailable),
	};
});

const availability: InterpreterAvailability = {
	js: { enabled: false, detected: { ok: false } },
	py: { enabled: true, detected: { ok: true, path: "python", version: "3" } },
	rb: { enabled: false, detected: { ok: false } },
	jl: { enabled: false, detected: { ok: false } },
};

describe("codemode session directory checks around kernel creation", () => {
	const managers: CodemodeSessionManager[] = [];
	let cwd = "";

	beforeEach(() => {
		cwd = realpathSync(mkdtempSync(join(tmpdir(), "codemode-cwd-lifecycle-")));
		harness.startKernel = async () => {
			throw new Error("kernel start was not configured");
		};
		harness.checkCwd = async (target, real) => await real(target);
	});

	afterEach(async () => {
		await Promise.allSettled(managers.splice(0).map((manager) => manager.dispose()));
		rmSync(cwd, { recursive: true, force: true });
	});

	async function createManager(): Promise<CodemodeSessionManager> {
		const manager = await createCodemodeSessionManager({
			sessionId: "session",
			cwd,
			settings: defaultCodemodeSettings,
			availability,
			executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
			complete: async () => ({ text: "ok", details: { model: "fake/model", structured: false } }),
		});
		managers.push(manager);
		return manager;
	}

	it("fails every caller sharing a creation with the named error when the session directory is deleted meanwhile", async () => {
		// Given: two cells wait on one in-flight creation in a session directory that exists at the start.
		const started = Promise.withResolvers<void>();
		const creation = Promise.withResolvers<EvalKernel>();
		harness.startKernel = () => {
			started.resolve();
			return creation.promise;
		};
		const manager = await createManager();
		const outcomes = Promise.allSettled([
			manager.getKernel("py", () => undefined),
			manager.getKernel("py", () => undefined),
		]);
		await started.promise;

		// When: the directory disappears while the interpreter is still starting.
		rmSync(cwd, { recursive: true, force: true });
		creation.resolve(new FakeKernel([]));

		// Then: neither cell runs in a directory that no longer exists.
		const settled = await outcomes;
		expect(settled.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
		for (const outcome of settled) {
			if (outcome.status !== "rejected") throw new Error("a caller ran in a deleted directory");
			expect(outcome.reason).toMatchObject({ name: "CodemodeSessionCwdUnavailableError", cwd });
		}
	});

	it("never hands out a kernel when the session is disposed while the directory is rechecked", async () => {
		// Given: the kernel is created and stored; its second directory check is still in flight.
		const kernel = new FakeKernel([]);
		harness.startKernel = async () => kernel;
		const recheckEntered = Promise.withResolvers<void>();
		const recheckGate = Promise.withResolvers<void>();
		let checks = 0;
		harness.checkCwd = async (target, real) => {
			await real(target);
			checks++;
			if (checks !== 2) return;
			recheckEntered.resolve();
			await recheckGate.promise;
		};
		const manager = await createManager();
		const outcome = manager
			.getKernel("py", () => undefined)
			.then(
				() => "returned a kernel",
				(error: unknown) => error,
			);
		await recheckEntered.promise;

		// When
		const disposal = manager.dispose();
		recheckGate.resolve();
		await disposal;

		// Then: the cell sees the disposal, and the disposal closes the stored kernel exactly once.
		expect(await outcome).toMatchObject({ name: "CodemodeSessionDisposedError" });
		expect(kernel.closeCount).toBe(1);
	});
});
