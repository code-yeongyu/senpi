/**
 * senpi#5654: the per-method sample fixture a parity test outside the engine enumerates. Guards a cross-repository
 * generated contract: one schema-valid record per method of the method-class table, committed byte-identical to the
 * generator, so a consumer never needs its own method list.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildRpcInboundSampleFixture,
	RPC_INBOUND_SAMPLE_FIXTURE,
	RPC_INBOUND_SAMPLES,
	type RpcInboundSampleFixture,
	SAMPLE_PATH_ROOT,
	serializeRpcInboundSampleFixture,
} from "../../scripts/rpc-inbound-samples.ts";
import { RPC_METHOD_CLASS, RPC_METHOD_CLASSES_DIGEST } from "../../src/modes/rpc/method-classes.ts";
import { validateRpcInboundRecord } from "../../src/modes/rpc/method-classes-schema.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", RPC_INBOUND_SAMPLE_FIXTURE);
const committed = (): RpcInboundSampleFixture => JSON.parse(readFileSync(fixturePath, "utf8"));
const sampleCount = (table: typeof RPC_INBOUND_SAMPLES): number => Object.keys(table).length;
const PATH_FIELDS = new Set(["sessionPath", "cwd", "path", "outputPath", "inputPath", "bundleDir", "parentSession"]);

describe("RPC inbound sample fixture (senpi#5654)", () => {
	it("is byte-identical to the generator output (regenerate with scripts/rpc-inbound-samples.ts --write)", () => {
		expect(readFileSync(fixturePath, "utf8")).toBe(serializeRpcInboundSampleFixture(buildRpcInboundSampleFixture()));
	});

	it("has exactly one row per method-class table entry and is pinned to the live table", () => {
		const fixture = committed();
		const methods = fixture.methods.map((entry) => entry.method);
		const tableMethods = Object.keys(RPC_METHOD_CLASS);
		expect(fixture.methodCount).toBe(tableMethods.length);
		expect(methods).toHaveLength(tableMethods.length);
		expect(new Set(methods).size).toBe(methods.length);
		expect([...methods].sort()).toEqual([...tableMethods].sort());
		expect(fixture.methodClassesDigest).toBe(RPC_METHOD_CLASSES_DIGEST);
	});

	it("fails the typecheck when a method has no sample", () => {
		const { prompt: _omitted, ...withoutPrompt } = RPC_INBOUND_SAMPLES;
		// @ts-expect-error -- prompt has no sample, so the table is not exhaustive
		expect(sampleCount(withoutPrompt)).toBe(Object.keys(RPC_METHOD_CLASS).length - 1);
	});

	it("every sample is a record of its own method that the inbound validator accepts", () => {
		const outcomes = committed().methods.map((entry) => ({
			method: entry.method,
			type: entry.sample.type,
			outcome: validateRpcInboundRecord(entry.sample),
		}));
		expect(outcomes.filter(({ method, type, outcome }) => method !== type || !outcome.ok)).toEqual([]);
	});

	it("marks exactly the connection_local samples as expected refusals", () => {
		const rows = committed().methods;
		expect(rows.filter((entry) => entry.connectionLocal).map((entry) => entry.method)).toEqual(
			rows.filter((entry) => entry.sampleClass === "connection_local").map((entry) => entry.method),
		);
		expect(rows.filter((entry) => entry.connectionLocal).length).toBeGreaterThan(0);
	});

	it("names host paths only under the nonexistent sample root", () => {
		const paths = committed().methods.flatMap((entry) =>
			Object.entries(entry.sample)
				.filter(([field, value]) => PATH_FIELDS.has(field) && typeof value === "string")
				.map(([field, value]) => [entry.method, field, value]),
		);
		expect(paths.length).toBeGreaterThan(0);
		expect(paths.filter(([, , value]) => !String(value).startsWith(`${SAMPLE_PATH_ROOT}/`))).toEqual([]);
	});
});
