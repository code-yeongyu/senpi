import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getAuthPath, getOrchestratorDir, getSocketPath } from "../src/config.ts";

const ENV_KEYS = ["SENPI_ORCHESTRATOR_DIR", "SENPI_CONFIG_DIR"] as const;

const previousEnv = new Map<(typeof ENV_KEYS)[number], string | undefined>();

beforeEach(() => {
	for (const key of ENV_KEYS) {
		previousEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const previousValue = previousEnv.get(key);
		if (previousValue === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = previousValue;
		}
	}
	previousEnv.clear();
});

describe("orchestrator config paths", () => {
	it("stores orchestrator state under the senpi config directory by default", () => {
		const orchestratorDir = join(homedir(), ".senpi", "orchestrator");

		assert.equal(getOrchestratorDir(), orchestratorDir);
		assert.equal(getAuthPath(), join(orchestratorDir, "auth.json"));
		assert.equal(getSocketPath(), join(orchestratorDir, "orchestrator.sock"));
	});

	it("uses SENPI_ORCHESTRATOR_DIR as the complete state directory override", () => {
		process.env.SENPI_ORCHESTRATOR_DIR = "/tmp/senpi-orchestrator-state";

		assert.equal(getOrchestratorDir(), "/tmp/senpi-orchestrator-state");
		assert.equal(getSocketPath(), "/tmp/senpi-orchestrator-state/orchestrator.sock");
	});

	it("uses SENPI_CONFIG_DIR as the parent config directory override", () => {
		process.env.SENPI_CONFIG_DIR = "/tmp/senpi-config";

		assert.equal(getOrchestratorDir(), "/tmp/senpi-config/orchestrator");
	});
});
