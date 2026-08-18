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

function writeExecutable(path, source) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, source);
	chmodSync(path, 0o755);
}

describe("smoke-standalone-binary", () => {
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

		const result = spawnSync(process.execPath, [smokeScript, binaryPath, workerPath], { encoding: "utf8" });

		assert.equal(result.status, 0, result.stderr);
		assert.equal(readFileSync(workerPath, "utf8"), `"use strict";\n`);
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
