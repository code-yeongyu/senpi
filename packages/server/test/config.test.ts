import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getAuthPath, getServerDir, getSocketPath } from "../src/config.ts";

const ENV_KEYS = ["SENPI_SERVER_DIR", "SENPI_ORCHESTRATOR_DIR", "SENPI_CONFIG_DIR"] as const;

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

describe("server config paths", () => {
	it("stores server state under the senpi config directory by default", () => {
		const serverDir = join(homedir(), ".senpi", "server");

		assert.equal(getServerDir(), serverDir);
		assert.equal(getAuthPath(), join(serverDir, "auth.json"));
		assert.equal(getSocketPath(), join(serverDir, "server.sock"));
	});

	it("uses SENPI_SERVER_DIR as the complete state directory override", () => {
		process.env.SENPI_SERVER_DIR = "/tmp/senpi-server-state";

		assert.equal(getServerDir(), "/tmp/senpi-server-state");
		assert.equal(getSocketPath(), "/tmp/senpi-server-state/server.sock");
	});

	it("keeps SENPI_ORCHESTRATOR_DIR as a legacy state directory override", () => {
		process.env.SENPI_ORCHESTRATOR_DIR = "/tmp/senpi-orchestrator-state";

		assert.equal(getServerDir(), "/tmp/senpi-orchestrator-state");
		assert.equal(getSocketPath(), "/tmp/senpi-orchestrator-state/server.sock");
	});

	it("uses SENPI_CONFIG_DIR as the parent config directory override", () => {
		process.env.SENPI_CONFIG_DIR = "/tmp/senpi-config";

		assert.equal(getServerDir(), "/tmp/senpi-config/server");
	});
});
