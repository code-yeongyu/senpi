#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("a long inherited temp path still gives tests room for an owned fallback socket (#3064)", {
	skip: process.platform === "win32",
}, () => {
	const parent = mkdtempSync(join(tmpdir(), "senpi-long-temp-proof-"));
	try {
		const long = join(parent, "deep-".repeat(30));
		mkdirSync(long);
		const runner = fileURLToPath(new URL("./run-tests.mjs", import.meta.url));
		const result = spawnSync(process.execPath, [runner, process.execPath, "-e", `
			const fs = require("node:fs"), path = require("node:path"), net = require("node:net");
			const directory = path.join(require("node:os").tmpdir(), "senpi-rpc-00000000", "tui");
			const socket = path.join(directory, "t-0000000000000000.sock");
			if (Buffer.byteLength(socket) > 103) throw new Error("owned socket exceeds sun_path");
			fs.mkdirSync(directory, { recursive: true });
			const server = net.createServer();
			server.listen(socket, () => server.close(() => console.log("SOCKET_CLOSED")));
		`], { env: { ...process.env, TMPDIR: long, TEMP: long, TMP: long }, encoding: "utf8", timeout: 10_000 });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /SOCKET_CLOSED/);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});
