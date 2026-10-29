import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot, resolveBun } from "./common.mjs";
import { HOST_PIN_ENV, hostPinEnv, pinnedHostFacts, pinnedWorkstation } from "./equivalence-host-pin.mjs";

const productModule = (...parts) => pathToFileURL(join(repoRoot(), "packages", ...parts)).href;
const WORKSTATION = productModule("coding-agent", "src", "core", "dynamic-prompt", "workstation.ts");
const HOST_FACTS = productModule("senpi-codemode", "src", "extension", "host-facts.ts");

// What the product's own prompt collectors report in a child started with the case env's pin: workstation.ts for the
// `<workstation>` block, host-facts.ts for the eval `Host:` line. Also the child's own os reads, which must stay real.
const PROBE = `
import * as os from "node:os";
const { collectWorkstationFacts } = await import(${JSON.stringify(WORKSTATION)});
const { hostLine } = await import(${JSON.stringify(HOST_FACTS)});
process.stdout.write(JSON.stringify({ facts: collectWorkstationFacts(), hostLine: hostLine(), cores: os.availableParallelism(), release: os.release() }));
`;

function probe(command, args) {
	const env = { ...process.env, ...hostPinEnv() };
	return JSON.parse(execFileSync(command, [...args, PROBE], { cwd: repoRoot(), env, encoding: "utf8" }));
}

function assertPinned(seen) {
	const pin = pinnedWorkstation();
	assert.equal(seen.facts.kernel, pin.kernel);
	assert.equal(seen.facts.cpu, `${pin.cpuModel} (${pin.cores} cores)`);
	// workstation.ts derives the GPU line from an "Apple " CPU model on darwin-arm64; the pinned model keeps that line.
	assert.equal(seen.facts.gpu, process.platform === "darwin" && process.arch === "arm64" ? pin.cpuModel : undefined);
	assert.equal(
		seen.hostLine.includes(` \u00b7 ${pin.cpuModel} \u00b7 ${pin.cores} cores \u00b7 `),
		true,
		seen.hostLine,
	);
	// Only the prompt facts are pinned: the child's own os reads (pool sizes, etc.) still see the real host.
	assert.equal(seen.cores, os.availableParallelism());
	assert.equal(seen.release, os.release());
}

test("a Bun CLI child with the case env's pin renders the pinned facts in both prompt sites", () => {
	assertPinned(probe(resolveBun().command, ["-e"]));
});

test("a Node CLI child with the case env's pin renders the pinned facts in both prompt sites", () => {
	assertPinned(probe(process.execPath, ["--input-type=module", "-e"]));
});

test("the pinned values are synthetic and the normalizer tokenizes each of them", () => {
	const pin = pinnedWorkstation();
	assert.deepEqual(JSON.parse(hostPinEnv()[HOST_PIN_ENV]), pin);
	assert.notEqual(pin.cores, os.availableParallelism());
	assert.match(pin.kernel, / 0\.0\.0-eq-synthetic$/);
	assert.equal(pinnedWorkstation("darwin", "arm64").cpuModel.startsWith("Apple "), true);
	assert.equal(pinnedWorkstation("linux", "x64").cpuModel.startsWith("Apple "), false);
	assert.deepEqual(
		pinnedHostFacts().map((fact) => fact.token),
		["<host:kernel>", "<host:release>", "<host:cpu>", "<host:cpu-model>", " <host:cores> cores"],
	);
});
