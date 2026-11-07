import assert from "node:assert/strict";
import test from "node:test";
import { evidenceDir, makeSandbox, scrubSandboxEnv } from "./common.mjs";

test("evidenceDir accepts one safe path segment", () => {
	const dir = evidenceDir("dollar-invocation-safe");
	assert.match(dir, /local-ignore\/qa-evidence\/\d{8}-dollar-invocation-safe$/);
});

test("scrubSandboxEnv drops the RPC host lane and internal-key sentinel a session hands its descendants", () => {
	const env = {
		SENPI_RPC_INTERNAL_KEY_STDIN: "1",
		SENPI_RPC_HOST_GENERATION: "10",
		SENPI_RPC_HOST_WATCH_PPID: "1234",
		SENPI_RPC_CLIENT_CAPABILITIES: "kept",
		PATH: "/usr/bin",
	};
	const scrubbed = scrubSandboxEnv(env);
	assert.deepEqual(Object.keys(env).sort(), ["PATH", "SENPI_RPC_CLIENT_CAPABILITIES"]);
	assert.deepEqual(scrubbed.sort(), [
		"SENPI_RPC_HOST_GENERATION",
		"SENPI_RPC_HOST_WATCH_PPID",
		"SENPI_RPC_INTERNAL_KEY_STDIN",
	]);
});

test("makeSandbox never hands the CLI an inherited internal-key sentinel (senpi#5548)", () => {
	const saved = process.env.SENPI_RPC_INTERNAL_KEY_STDIN;
	process.env.SENPI_RPC_INTERNAL_KEY_STDIN = "1";
	const box = makeSandbox("scrub-internal-key");
	try {
		assert.equal(box.env.SENPI_RPC_INTERNAL_KEY_STDIN, undefined);
	} finally {
		box.cleanup();
		if (saved === undefined) delete process.env.SENPI_RPC_INTERNAL_KEY_STDIN;
		else process.env.SENPI_RPC_INTERNAL_KEY_STDIN = saved;
	}
});

test("evidenceDir rejects path traversal and nested paths", () => {
	for (const slug of ["../escape", "nested/path", "nested\\path", ".", "..", ""]) {
		assert.throws(() => evidenceDir(slug), /single safe path segment/);
	}
});
