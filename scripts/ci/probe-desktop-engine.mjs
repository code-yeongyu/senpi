#!/usr/bin/env node
// Lifecycle probe for a staged senpi-desktop-engine binary: `--selftest` exits 0,
// and `--stdio` answers `capabilities` with backend "fake" under
// SENPI_DESKTOP_BACKEND=fake:<scenario> and the host's native backend without it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const HANG_GUARD_MS = 30_000;
// The native backend each host's engine dispatches to when no backend is forced. Linux picks X11 or
// Wayland from DISPLAY/WAYLAND_DISPLAY, which a headless CI runner does not set, so it reports
// "unavailable" there.
const NATIVE_BACKEND = { darwin: "quartz", win32: "win32" };
const expectedNativeBackend = NATIVE_BACKEND[process.platform] ?? "unavailable";

if (process.argv.length !== 4) {
	console.error("usage: probe-desktop-engine.mjs <senpi-desktop-engine binary> <fake scenario.json>");
	process.exit(2);
}
const binary = resolve(process.argv[2]);
const scenario = resolve(process.argv[3]);

function run(args, { input, backend }) {
	const env = { ...process.env };
	delete env.SENPI_DESKTOP_BACKEND;
	if (backend !== undefined) env.SENPI_DESKTOP_BACKEND = backend;
	const result = spawnSync(binary, args, { input, env, encoding: "utf8", timeout: HANG_GUARD_MS });
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${args.join(" ")} exited ${result.status}\nstderr: ${result.stderr}`);
	return result.stdout;
}

function capabilitiesBackend(backend) {
	const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "capabilities", params: {} })}\n`;
	const replies = run(["--stdio"], { input: request, backend })
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
	const reply = replies.find((message) => message.id === 1);
	assert.ok(reply?.result, `no capabilities result: ${JSON.stringify(replies)}`);
	return reply.result.backend;
}

const selftest = run(["--selftest"], {});
assert.match(selftest, /engine: selftest ok/);
console.log("selftest=ok");

const withFake = capabilitiesBackend(`fake:${scenario}`);
assert.equal(withFake, "fake");
console.log(`backend=${withFake}`);

const withoutBackend = capabilitiesBackend(undefined);
assert.equal(withoutBackend, expectedNativeBackend);
console.log(`backend=${withoutBackend}`);
