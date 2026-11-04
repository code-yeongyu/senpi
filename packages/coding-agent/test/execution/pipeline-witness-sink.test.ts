// S18b part 3: execution-pipeline receipts go to a sink OUTSIDE the session. A session takes the sink it is given;
// without one, SENPI_EXECUTION_PIPELINE_WITNESS names a file that gets one JSON line per call; with neither, no receipts.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { resolveWitnessSink } from "../../src/core/execution/pipeline-witness-sink.ts";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const witnessFile = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "pipeline-witness-"));
	dirs.push(dir);
	return join(dir, "witness.jsonl");
};
const lines = (path: string): unknown[] =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));

async function session() {
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	return {
		modelRuntime,
		cwd: process.cwd(),
		settingsManager: SettingsManager.inMemory(),
		sessionManager: SessionManager.inMemory(),
	};
}

describe("resolveWitnessSink", () => {
	it("takes the configured sink over the env file", () => {
		const sink = () => {};
		expect(resolveWitnessSink(sink, { SENPI_EXECUTION_PIPELINE_WITNESS: witnessFile() })).toBe(sink);
	});

	it("appends one JSON line per receipt to the env file", () => {
		const path = witnessFile();
		const sink = resolveWitnessSink(undefined, { SENPI_EXECUTION_PIPELINE_WITNESS: path });
		sink?.({ pipeline: "prepared", toolCallId: "call-1" });
		sink?.({ pipeline: "legacy", toolCallId: "call-2" });
		expect(lines(path)).toEqual([
			{ pipeline: "prepared", toolCallId: "call-1" },
			{ pipeline: "legacy", toolCallId: "call-2" },
		]);
	});

	it("installs no sink when neither is set", () => {
		expect(resolveWitnessSink(undefined, {})).toBeUndefined();
		expect(resolveWitnessSink(undefined, { SENPI_EXECUTION_PIPELINE_WITNESS: "" })).toBeUndefined();
	});
});

describe("createAgentSession", () => {
	it("gives the session's agent the configured witness sink", async () => {
		const sink = vi.fn();
		const { session: created } = await createAgentSession({ ...(await session()), executionPipelineWitness: sink });
		expect(created.agent.onExecutionPipeline).toBe(sink);
	});

	it("writes receipts to the SENPI_EXECUTION_PIPELINE_WITNESS file when it is given no sink", async () => {
		const path = witnessFile();
		vi.stubEnv("SENPI_EXECUTION_PIPELINE_WITNESS", path);
		const { session: created } = await createAgentSession(await session());
		await created.agent.onExecutionPipeline?.({ pipeline: "prepared", toolCallId: "call-1" });
		expect(lines(path)).toEqual([{ pipeline: "prepared", toolCallId: "call-1" }]);
	});
});
