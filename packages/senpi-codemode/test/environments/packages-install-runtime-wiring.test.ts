import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultCodemodeSettings } from "../../src/config/settings.ts";
import { createRuntime } from "../../src/extension/runtime-factory.ts";
import type {
	CodemodeSessionManager,
	CreateCodemodeSessionManagerOptions,
} from "../../src/extension/session-manager.ts";
import { createInterpreterDetector, getInterpreterAvailability } from "../../src/interpreters/detect.ts";
import { fakeExtensionContext } from "../eval/fakes.ts";

const pyAvailability = await getInterpreterAvailability(
	{ ...defaultCodemodeSettings, languages: { js: true, py: true, rb: false, jl: false } },
	createInterpreterDetector(),
);
const directories: string[] = [];

afterAll(async () => {
	await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

const inertManager: CodemodeSessionManager = {
	getKernel: async () => {
		throw new Error("no kernel in this test");
	},
	dispose: async () => {},
	complete: async () => ({ text: "", details: { model: "fake/fake", structured: false } }),
};

describe.skipIf(!pyAvailability.py.detected.ok)("Given a session runtime with Python enabled", () => {
	it("When it is created, then the bridge's packages.install() and the %pip magics share one Python environment", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "senpi-packages-wiring-"));
		directories.push(cwd);
		let captured: CreateCodemodeSessionManagerOptions | undefined;
		const pi = {
			getActiveTools: () => ["eval"],
			getAllTools: () => [{ name: "eval" }],
			executeTool: async () => {
				throw new Error("no tools in this test");
			},
		};

		const runtime = await createRuntime(
			pi,
			{
				...fakeExtensionContext(),
				cwd,
				sessionManager: {
					...fakeExtensionContext().sessionManager,
					getSessionId: () => "wiring",
					getSessionFile: () => undefined,
				},
			},
			{ sessionId: "wiring" },
			async () => ({ text: "", details: { model: "fake/fake", structured: false } }),
			{
				createSessionManager: (options) => {
					captured = options;
					return inertManager;
				},
			},
		);

		expect(runtime.pythonEnvironments).toBeDefined();
		expect(captured?.environments?.python).toBe(runtime.pythonEnvironments);
	});
});
