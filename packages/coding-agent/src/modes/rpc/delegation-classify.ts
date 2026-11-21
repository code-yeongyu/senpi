/** The `classify_record` answer (senpi#5632): the class of one record, without running it, on any connection. */
import type { DelegationResponse } from "./delegation-wire.ts";
import { requestId } from "./delegation-wire.ts";
import { ruleDataOf } from "./method-class-rule-data.ts";
import {
	classifyRpcMethod,
	RPC_METHOD_CLASS,
	RPC_METHOD_CLASSES_DIGEST,
	RPC_METHOD_CLASSES_VERSION,
	type RpcMethodType,
} from "./method-classes.ts";

export const CLASSIFY_RECORD_COMMAND = "classify_record";

export function classifyRecord(record: object): DelegationResponse {
	const id = requestId(record);
	const target: unknown = Reflect.get(record, "record");
	const methodClass = classifyRpcMethod(target);
	const type = typeof target === "object" && target !== null ? Reflect.get(target, "type") : undefined;
	const entry =
		methodClass !== undefined && typeof type === "string" ? RPC_METHOD_CLASS[type as RpcMethodType] : undefined;
	const ruleData = entry === undefined ? undefined : ruleDataOf(entry);
	return {
		...(id === undefined ? {} : { id }),
		type: "response",
		command: CLASSIFY_RECORD_COMMAND,
		success: true,
		data: {
			class: methodClass ?? null,
			version: RPC_METHOD_CLASSES_VERSION,
			digest: RPC_METHOD_CLASSES_DIGEST,
			...(entry === undefined
				? {}
				: typeof entry === "string"
					? { static: true }
					: { static: false, rule: entry.version, ...(ruleData === undefined ? {} : { rule_data: ruleData }) }),
		},
	};
}
