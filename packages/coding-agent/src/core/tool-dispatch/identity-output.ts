import {
	IDENTITY_MASK,
	IdentityOutputStream,
	isPrivateField,
	isSecretBytes,
	redactIdentityText,
} from "@code-yeongyu/senpi-machine-ops";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

type TextFilter = (text: string, path: string, key: string) => string;
function sanitize(
	value: unknown,
	visited: WeakMap<object, object>,
	filter: TextFilter = redactIdentityText,
	path = "",
	field = "",
): unknown {
	if (typeof value === "string") return filter(value, path, field);
	if (!value || typeof value !== "object" || value instanceof Map || value instanceof Set || ArrayBuffer.isView(value))
		return value;
	const previous = visited.get(value);
	if (previous) return previous;
	const error = value instanceof Error;
	// Materialize V8's stack before changing the message; preserve its original frames.
	if (error && typeof value.stack === "string") {
		const stack = redactIdentityText(value.stack);
		if (stack !== value.stack) value.stack = stack;
	}
	const human = "kind" in value && value.kind === "human" && "v" in value && value.v === 1;
	const output: object = error ? value : Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
	visited.set(value, output);
	let changed = false;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	for (const [key, desc] of Object.entries(descriptors)) {
		const accessor = !("value" in desc);
		if ((accessor && !desc.get) || (!desc.enumerable && !error)) continue;
		let child: unknown;
		try {
			child = accessor ? desc.get?.call(value) : desc.value;
		} catch {
			// A getter that throws yields no value to any reader; leave it as it is.
			continue;
		}
		const sensitive =
			(isPrivateField(key) && isSecretBytes(child)) ||
			(human && (key === "secretKey" || key === "sealedKey") && typeof child === "string");
		const next = sensitive
			? IDENTITY_MASK
			: sanitize(child, visited, filter, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, key);
		// A copied getter could still return the secret later: evaluate it into a data property.
		if (next === child && !(accessor && !error)) continue;
		changed = true;
		const replaced = accessor
			? { value: next, enumerable: desc.enumerable, configurable: true, writable: true }
			: { ...desc, value: next };
		if (error) Object.defineProperty(output, key, replaced);
		else descriptors[key] = replaced;
	}
	if (!error && !changed) {
		visited.set(value, value);
		return value;
	}
	if (!error) Object.defineProperties(output, descriptors);
	return output;
}

export function redactIdentityOutput<T>(value: T): T {
	return sanitize(value, new WeakMap()) as T;
}

/** Tool updates can be cumulative snapshots or incremental chunks. Never emit an undecided
 * suffix. Final results are separate complete values, not a reason to flush unverified bytes. */
export function identityUpdateFilter() {
	const blocks = new Map<string, { stream: IdentityOutputStream; previous: string; output: string }>();
	return <T>(frame: AgentToolResult<T>): AgentToolResult<T> => {
		return sanitize(frame, new WeakMap(), (text, path, key) => {
			if (!blocks.has(path) && !/^(?:text|stdout|stderr|output|message|details)$/i.test(key) && !text.includes("{"))
				return redactIdentityText(text);
			const state = blocks.get(path) ?? { stream: new IdentityOutputStream(), previous: "", output: "" };
			const snapshot = text.startsWith(state.previous);
			const part = state.stream.push(snapshot ? text.slice(state.previous.length) : text);
			state.previous = text;
			state.output = snapshot ? state.output + part : part;
			blocks.set(path, state);
			return state.output;
		}) as AgentToolResult<T>;
	};
}
