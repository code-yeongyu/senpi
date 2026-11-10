/**
 * Record-dependent rules written as data (senpi#6318). A rule that reads one field of the record is declared here as
 * `{ version, field, map, default }`, and the engine's classifier for it is built from that same data, so what
 * `classify_record` and `get_protocol_info.method_classes` publish is exactly the rule the engine runs. A client that
 * evaluates the data needs no copy of the rule and no round trip per record.
 *
 * Language version 1 (`RPC_RULE_DATA_VERSION`): read `record[field]`; when it is a string and an own key of `map`, the
 * class is `map[value]`, otherwise `default`. Nothing in it executes. A client that does not know the version, or
 * cannot read the shape, ignores the data and asks `classify_record` for every record.
 */

import type { RpcMethodClass } from "./method-classes.ts";

const RPC_RULE_DATA_VERSION = 1;

export interface RpcMethodClassRuleData {
	readonly version: typeof RPC_RULE_DATA_VERSION;
	readonly field: string;
	readonly map: Readonly<Record<string, RpcMethodClass>>;
	readonly default: RpcMethodClass;
}

export interface RpcMethodClassFieldRule {
	readonly version: number;
	readonly data: RpcMethodClassRuleData;
	readonly classify: (record: object) => RpcMethodClass;
}

function classifyByRuleData(data: RpcMethodClassRuleData, record: object): RpcMethodClass {
	const value: unknown = Reflect.get(record, data.field);
	const mapped = typeof value === "string" && Object.hasOwn(data.map, value) ? data.map[value] : undefined;
	return mapped ?? data.default;
}

export function fieldRule(
	version: number,
	field: string,
	map: Readonly<Record<string, RpcMethodClass>>,
	fallback: RpcMethodClass,
): RpcMethodClassFieldRule {
	const data: RpcMethodClassRuleData = Object.freeze({
		version: RPC_RULE_DATA_VERSION,
		field,
		map: Object.freeze({ ...map }),
		default: fallback,
	});
	return { version, data, classify: (record) => classifyByRuleData(data, record) };
}

type TableEntry = RpcMethodClass | { readonly version: number; readonly data?: RpcMethodClassRuleData };

export function ruleDataOf(entry: TableEntry): RpcMethodClassRuleData | undefined {
	return typeof entry === "string" ? undefined : entry.data;
}

export function ruleDataTable(table: Readonly<Record<string, TableEntry>>): Record<string, RpcMethodClassRuleData> {
	return Object.fromEntries(
		Object.entries(table).flatMap(([type, entry]) => {
			const data = ruleDataOf(entry);
			return data === undefined ? [] : [[type, data]];
		}),
	);
}
