import { createHash } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { FrozenCall, StoreValue } from "@earendil-works/pi-agent-core/conformance";

function canonical(value: StoreValue): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

/** Tool arguments and results are JSON on every model and wire path; a round trip drops what JSON cannot carry. */
export function toStoreValue(value: unknown): StoreValue {
	const json = JSON.stringify(value);
	return json === undefined ? null : JSON.parse(json);
}

export function digestOf(value: StoreValue): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}

/** The call after the whole `tool_call` chain, detached from every object a handler or caller still holds. */
export function freezeCall(name: string, args: unknown): FrozenCall {
	const frozenArgs = toStoreValue(args);
	return { name, args: frozenArgs, digest: digestOf({ name, args: frozenArgs }) };
}

/** The durable record of a settled body: what the issuer commits before ACK. Details stay in the in-process reply. */
export function resultValue(result: AgentToolResult<unknown>, isError: boolean): StoreValue {
	return toStoreValue({ content: result.content ?? [], isError });
}
