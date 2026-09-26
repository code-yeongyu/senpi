import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smokeScript = join(repoRoot, "scripts", "smoke-standalone-binary.mjs");
let tempDir;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

const engineFile = process.platform === "win32" ? "senpi-desktop-engine.exe" : "senpi-desktop-engine";
const requireEngine = { ...process.env, SENPI_SMOKE_REQUIRE_DESKTOP_ENGINE: "1" };

/** A scripted engine at the sidecar path: answers engine.hello and capabilities like the fake backend. */
function placeEngineSidecar(binaryPath) {
	const sidecar = join(dirname(binaryPath), "native", "prebuilds", `${process.platform}-${process.arch}`, engineFile);
	writeExecutable(
		sidecar,
		`#!/usr/bin/env node
let buffer = "";
process.stdin.on("data", (chunk) => { buffer += chunk; });
process.stdin.on("end", () => {
	for (const line of buffer.split("\\n").filter(Boolean)) {
		const request = JSON.parse(line);
		const result = request.method === "engine.hello" ? { abi: "senpi-desktop/1" } : { backend: process.env.SENPI_DESKTOP_BACKEND?.startsWith("fake:") ? "fake" : "none" };
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
	}
});
`,
	);
	return sidecar;
}

function writeExecutable(path, source) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, source);
	chmodSync(path, 0o755);
}

describe("smoke-standalone-binary", () => {
	for (const enabled of [true, false]) {
		it(`rejects ${enabled ? "duplicate" : "disabled"} codemode entries when RPC reports success`, () => {
			// Given: a successful RPC envelope with invalid codemode membership.
			tempDir = mkdtempSync(join(tmpdir(), "senpi-standalone-smoke-"));
			const workerPath = join(tempDir, "worker.js");
			writeFileSync(workerPath, "export {};\n");
			const binaryPath = join(tempDir, "invalid-inventory");
			const entry = { name: "codemode", path: "<builtin:codemode>", enabled };
			const response = {
				id: "standalone-smoke-surfaces", type: "response", command: "get_loaded_surfaces", success: true,
				data: { extensions: enabled ? [entry, entry] : [entry], mcpServers: [] },
			};
			writeExecutable(binaryPath, `#!/usr/bin/env node\nprocess.stdout.write(process.argv.includes("--mode") ? ${JSON.stringify(`${JSON.stringify(response)}\n`)} : "ok");\n`);

			// When: the standalone smoke evaluates the machine-consumed inventory.
			const result = spawnSync(process.execPath, [smokeScript, binaryPath, workerPath], { encoding: "utf8" });

			// Then: a successful envelope cannot hide duplicate or disabled membership.
			assert.notEqual(result.status, 0);
			assert.equal(readFileSync(workerPath, "utf8"), "export {};\n");
		});
	}
	it("fails a binary that still depends on the build-time worker file", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-standalone-smoke-"));
		const workerPath = join(tempDir, "node_modules", "jsdom", "xhr-sync-worker.js");
		mkdirSync(dirname(workerPath), { recursive: true });
		writeFileSync(workerPath, `"use strict";\n`);
		const binaryPath = join(tempDir, "broken-binary");
		writeExecutable(
			binaryPath,
			`#!/usr/bin/env node\nconst { existsSync } = require("node:fs");\nif (!existsSync(${JSON.stringify(workerPath)})) process.exit(2);\nprocess.stdout.write(process.argv[2]);\n`,
		);

		const result = spawnSync(process.execPath, [smokeScript, binaryPath, workerPath], { encoding: "utf8" });

		assert.notEqual(result.status, 0);
		assert.equal(readFileSync(workerPath, "utf8"), `"use strict";\n`);
	});

	it("passes a relocated binary that does not need the build-time worker file", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-standalone-smoke-"));
		const workerPath = join(tempDir, "node_modules", "jsdom", "xhr-sync-worker.js");
		mkdirSync(dirname(workerPath), { recursive: true });
		writeFileSync(workerPath, `"use strict";\n`);
		const binaryPath = join(tempDir, "fixed-binary");
		writeExecutable(
			binaryPath,
			`#!/usr/bin/env node
if (process.argv.includes("--mode")) {
	process.stdout.write(${JSON.stringify(
		`${JSON.stringify({
			id: "standalone-smoke-surfaces",
			type: "response",
			command: "get_loaded_surfaces",
			success: true,
			data: {
				extensions: [{ name: "codemode", path: "<builtin:codemode>", enabled: true }],
				mcpServers: [],
			},
		})}\n`,
	)});
} else {
	process.stdout.write(process.argv[2] === "--version" ? "2026.8.5" : "help");
}
`,
		);

		placeEngineSidecar(binaryPath);

		const result = spawnSync(process.execPath, [smokeScript, binaryPath, workerPath], { encoding: "utf8", env: requireEngine });

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /desktop engine: backend=fake abi=senpi-desktop\/1/);
		assert.equal(readFileSync(workerPath, "utf8"), `"use strict";\n`);
	});

	it("fails a relocated binary shipped without its desktop engine sidecar", () => {
		// Given: a binary that passes every other step, with no engine next to it.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-standalone-smoke-"));
		const workerPath = join(tempDir, "worker.js");
		writeFileSync(workerPath, "export {};\n");
		const binaryPath = join(tempDir, "no-engine-binary");
		const response = {
			id: "standalone-smoke-surfaces", type: "response", command: "get_loaded_surfaces", success: true,
			data: { extensions: [{ name: "codemode", path: "<builtin:codemode>", enabled: true }], mcpServers: [] },
		};
		writeExecutable(binaryPath, `#!/usr/bin/env node\nprocess.stdout.write(process.argv.includes("--mode") ? ${JSON.stringify(`${JSON.stringify(response)}\n`)} : "ok");\n`);

		// When
		const result = spawnSync(process.execPath, [smokeScript, binaryPath, workerPath], { encoding: "utf8", env: requireEngine });

		// Then: a packaging regression fails the smoke instead of passing silently.
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /desktop engine sidecar missing at .*senpi-desktop-engine/);
	});

	it("fails a relocated binary whose RPC inventory omits bundled codemode", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-standalone-smoke-"));
		const workerPath = join(tempDir, "node_modules", "jsdom", "xhr-sync-worker.js");
		mkdirSync(dirname(workerPath), { recursive: true });
		writeFileSync(workerPath, `"use strict";\n`);
		const binaryPath = join(tempDir, "missing-codemode-binary");
		writeExecutable(
			binaryPath,
			`#!/usr/bin/env node
if (process.argv.includes("--mode")) {
	process.stdout.write(${JSON.stringify(
		`${JSON.stringify({
			id: "standalone-smoke-surfaces",
			type: "response",
			command: "get_loaded_surfaces",
			success: true,
			data: { extensions: [], mcpServers: [] },
		})}\n`,
	)});
} else {
	process.stdout.write(process.argv[2] === "--version" ? "2026.8.11-3" : "help");
}
`,
		);

		const result = spawnSync(process.execPath, [smokeScript, binaryPath, workerPath], { encoding: "utf8" });

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /<builtin:codemode>/);
		assert.equal(readFileSync(workerPath, "utf8"), `"use strict";\n`);
	});

	it("fails a relocated binary that emits malformed RPC output", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-standalone-smoke-"));
		const workerPath = join(tempDir, "node_modules", "jsdom", "xhr-sync-worker.js");
		mkdirSync(dirname(workerPath), { recursive: true });
		writeFileSync(workerPath, `"use strict";\n`);
		const binaryPath = join(tempDir, "malformed-rpc-binary");
		writeExecutable(
			binaryPath,
			`#!/usr/bin/env node
if (process.argv.includes("--mode")) {
	process.stdout.write("not-json\\n");
	process.stdout.write(${JSON.stringify(
		`${JSON.stringify({
			id: "standalone-smoke-surfaces",
			type: "response",
			command: "get_loaded_surfaces",
			success: true,
			data: {
				extensions: [{ name: "codemode", path: "<builtin:codemode>", enabled: true }],
				mcpServers: [],
			},
		})}\n`,
	)});
} else {
	process.stdout.write(process.argv[2] === "--version" ? "2026.8.11-3" : "help");
}
`,
		);

		const result = spawnSync(process.execPath, [smokeScript, binaryPath, workerPath], { encoding: "utf8" });

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /malformed RPC output/);
	});

	it("fails a relocated binary whose loaded-surfaces response is unsuccessful", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-standalone-smoke-"));
		const workerPath = join(tempDir, "node_modules", "jsdom", "xhr-sync-worker.js");
		mkdirSync(dirname(workerPath), { recursive: true });
		writeFileSync(workerPath, `"use strict";\n`);
		const binaryPath = join(tempDir, "failed-rpc-binary");
		writeExecutable(
			binaryPath,
			`#!/usr/bin/env node
if (process.argv.includes("--mode")) {
	process.stdout.write(${JSON.stringify(
		`${JSON.stringify({
			id: "standalone-smoke-surfaces",
			type: "response",
			command: "get_loaded_surfaces",
			success: false,
			error: "synthetic failure",
			data: {
				extensions: [{ name: "codemode", path: "<builtin:codemode>", enabled: true }],
				mcpServers: [],
			},
		})}\n`,
	)});
} else {
	process.stdout.write(process.argv[2] === "--version" ? "2026.8.11-3" : "help");
}
`,
		);

		const result = spawnSync(process.execPath, [smokeScript, binaryPath, workerPath], { encoding: "utf8" });

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /unsuccessful loaded-surfaces response/);
	});
});
