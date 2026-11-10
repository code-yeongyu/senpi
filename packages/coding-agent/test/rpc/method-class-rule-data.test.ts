/**
 * senpi#6318: a record-dependent rule that is one field lookup is published as data, on `classify_record` and in
 * `get_protocol_info.method_classes`, so a forwarder runs the engine's own rule instead of asking for every record or
 * keeping its own copy. Cross-language contract: `evaluate` below is rule-data language version 1 exactly as
 * docs/rpc.md states it for clients, and every record shape the rule fixtures know must get the engine's own class
 * from the published data.
 */
import { describe, expect, it } from "vitest";
import { classifyRecord } from "../../src/modes/rpc/delegation-classify.ts";
import {
	classifyRpcMethod,
	describeRpcMethodClasses,
	RPC_METHOD_CLASSES_DIGEST,
	RPC_METHOD_CLASSES_VERSION,
} from "../../src/modes/rpc/method-classes.ts";
import { RULE_FIXTURES } from "./method-class-rule-fixtures.ts";

type Wire = Record<string, unknown>;

const CLASSES: ReadonlySet<unknown> = new Set(["observe", "drive", "answer", "thread", "device_admin", "connection_local"]);

function evaluate(rule: unknown, record: Wire): unknown {
	if (typeof rule !== "object" || rule === null) return undefined;
	const { version, field, map, default: fallback } = rule as Wire;
	if (version !== 1 || typeof field !== "string" || typeof map !== "object" || map === null) return undefined;
	if (!CLASSES.has(fallback)) return undefined;
	const value = record[field];
	return typeof value === "string" && Object.hasOwn(map, value) ? (map as Wire)[value] : fallback;
}

const wire = (value: unknown): Wire => JSON.parse(JSON.stringify(value)) as Wire;
const answer = (record: Wire): Wire => wire(classifyRecord({ id: "c", record })).data as Wire;
const typeOf = (key: string): string => key.slice(0, key.indexOf("@"));

const edgeShapes = (field: string): ReadonlyArray<Wire> => [
	{},
	{ [field]: null },
	{ [field]: 7 },
	{ [field]: true },
	{ [field]: ["session"] },
	{ [field]: { session: true } },
	{ [field]: "" },
	{ [field]: "zz_unknown" },
	{ [field]: "__proto__" },
	{ [field]: "toString" },
	{ [field]: "SESSION" },
];

describe("rule data (senpi#6318)", () => {
	it("answers set_model@1 and set_thinking_level@1 with their rule as data, keeping static and rule", () => {
		expect(answer({ type: "set_model", provider: "p", modelId: "m" })).toEqual({
			class: "device_admin",
			version: RPC_METHOD_CLASSES_VERSION,
			digest: RPC_METHOD_CLASSES_DIGEST,
			static: false,
			rule: 1,
			rule_data: { version: 1, field: "scope", map: { session: "drive" }, default: "device_admin" },
		});
		expect(answer({ type: "set_thinking_level", level: "high", scope: "turn" })).toEqual({
			class: "drive",
			version: RPC_METHOD_CLASSES_VERSION,
			digest: RPC_METHOD_CLASSES_DIGEST,
			static: false,
			rule: 1,
			rule_data: { version: 1, field: "scope", map: { turn: "drive" }, default: "device_admin" },
		});
	});

	it("publishes no rule data for a static type, an unclassified record, or a rule that is not one field lookup", () => {
		expect(answer({ type: "get_state" })).not.toHaveProperty("rule_data");
		expect(answer({ type: "zz_unclassified_probe" })).not.toHaveProperty("rule_data");
		expect(answer({ type: "prompt", message: "/mcp" })).toMatchObject({ static: false, rule: 1 });
		expect(answer({ type: "prompt", message: "/mcp" })).not.toHaveProperty("rule_data");
	});

	it("advertises in method_classes the same rule data classify_record answers, for dynamic types only", () => {
		const description = wire(describeRpcMethodClasses());
		const published = description.rule_data as Wire;
		const versions = description.dynamic_versions as Wire;
		for (const type of Object.keys(published)) expect([type, Object.hasOwn(versions, type)]).toEqual([type, true]);
		for (const [key, cases] of Object.entries(RULE_FIXTURES)) {
			const type = typeOf(key);
			for (const [, fields] of cases) expect([type, published[type]]).toEqual([type, answer({ ...fields, type }).rule_data]);
		}
	});

	it("decides every record shape the tests know as the engine's own classifier does", () => {
		const published = Object.entries(wire(describeRpcMethodClasses()).rule_data as Wire);
		expect(published.map(([type]) => type).sort()).toEqual(["set_model", "set_thinking_level"]);
		for (const [type, rule] of published) {
			const { field, map } = rule as { field: string; map: Wire };
			const fixtures = Object.entries(RULE_FIXTURES).flatMap(([key, cases]) =>
				typeOf(key) === type ? cases.map(([, fields]) => fields) : [],
			);
			expect([type, fixtures.length > 0]).toEqual([type, true]);
			const mapped = Object.keys(map).map((value) => ({ [field]: value }));
			for (const fields of [...fixtures, ...mapped, ...edgeShapes(field)]) {
				const record = { ...fields, type };
				expect([record, evaluate(rule, record)]).toEqual([record, classifyRpcMethod(record)]);
			}
		}
	});
});
