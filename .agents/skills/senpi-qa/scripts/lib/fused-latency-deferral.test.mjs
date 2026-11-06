// EQ.perf deferrals (senpi#5233): the driver may report a metric DEFERRED only while the producer it names has not
// landed. A deferral that names a producer whose artifact is on this tree is stale and fails here, so the metric gets
// measured instead of silently skipped.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRIVER = join(SKILL, "scripts", "scenarios", "fused-latency-qa.mjs");

/** The plan's producer rows (work plan, producer table) for the work EQ.perf depends on: id -> its landed artifact. */
const PRODUCER_ARTIFACTS = {
	"P0-05b": "scripts/scenarios/fused-equivalence-qa.mjs",
	"P0-05c": "scripts/lib/equivalence-tui-capture.mjs",
};

/** Producer ids named on any driver line that mentions a deferral. */
function deferredProducers(source) {
	return [
		...new Set(
			source
				.split("\n")
				.filter((line) => /DEFERRED/i.test(line))
				.flatMap((line) => line.match(/\bP\d+-\d+[a-z]?\b/g) ?? []),
		),
	];
}

test("no EQ.perf deferral names a producer that has landed", () => {
	const source = readFileSync(DRIVER, "utf8");
	for (const producer of deferredProducers(source)) {
		const artifact = PRODUCER_ARTIFACTS[producer];
		assert.ok(artifact, `deferral names ${producer}: add its artifact to PRODUCER_ARTIFACTS`);
		assert.ok(
			!existsSync(join(SKILL, artifact)),
			`deferral names ${producer}, but its artifact ${artifact} has landed: measure the metric instead`,
		);
	}
});

test("the driver measures and compares tui_frame_ms instead of deferring it", () => {
	const source = readFileSync(DRIVER, "utf8");
	assert.ok(!/DEFERRED/.test(source), "the driver still carries a deferral");
	assert.ok(/measureTuiFrames/.test(source), "the driver has no TUI frame-time measurement");
});

test("a deferral line naming a landed producer is detected", () => {
	assert.deepEqual(deferredProducers('const DEFERRED = { tui_frame_ms: "P0-05c" };\nconst other = "P0-05b";\n'), [
		"P0-05c",
	]);
	assert.deepEqual(deferredProducers("// no deferral mentions P0-05c here\n"), []);
});
