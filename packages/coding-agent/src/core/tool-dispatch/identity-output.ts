import {
	IDENTITY_MASK,
	IdentityOutputStream,
	isPrivateField,
	isSecretBytes,
	redactIdentityText,
} from "@code-yeongyu/senpi-machine-ops";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

type TextFilter = (text: string, path: () => string, key: string) => string;

interface Frame {
	value: object;
	output: object;
	error: boolean;
	human: boolean;
	segment: string;
	descriptors: { [key: string]: PropertyDescriptor };
	entries: [string, PropertyDescriptor][];
	index: number;
	changed: boolean;
	pending?: { key: string; desc: PropertyDescriptor; accessor: boolean; child: unknown };
}

const pointer = (key: string) => `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
const isContainer = (value: unknown): value is object =>
	!!value && typeof value === "object" && !(value instanceof Map || value instanceof Set || ArrayBuffer.isView(value));

function open(value: object, segment: string, visited: WeakMap<object, object>): Frame {
	const error = value instanceof Error;
	// Materialize V8's stack before changing the message; preserve its original frames.
	if (error && typeof value.stack === "string") {
		const stack = redactIdentityText(value.stack);
		if (stack !== value.stack) value.stack = stack;
	}
	const output: object = error ? value : Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
	visited.set(value, output);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	return {
		value,
		output,
		error,
		human: "kind" in value && value.kind === "human" && "v" in value && value.v === 1,
		segment,
		descriptors,
		entries: Object.entries(descriptors),
		index: 0,
		changed: false,
	};
}

function settle(frame: Frame, key: string, desc: PropertyDescriptor, accessor: boolean, child: unknown, next: unknown) {
	// A copied getter could still return the secret later: evaluate it into a data property.
	if (next === child && !(accessor && !frame.error)) return;
	frame.changed = true;
	const replaced = accessor
		? { value: next, enumerable: desc.enumerable, configurable: true, writable: true }
		: { ...desc, value: next };
	if (frame.error) Object.defineProperty(frame.output, key, replaced);
	else frame.descriptors[key] = replaced;
}

function close(frame: Frame, visited: WeakMap<object, object>): object {
	if (!frame.error && !frame.changed) {
		visited.set(frame.value, frame.value);
		return frame.value;
	}
	if (!frame.error) Object.defineProperties(frame.output, frame.descriptors);
	return frame.output;
}

/** Depth-first with an explicit stack: a tool result may nest far past the call stack. */
function sanitize(root: unknown, filter: TextFilter = redactIdentityText): unknown {
	if (typeof root === "string") return filter(root, () => "", "");
	if (!isContainer(root)) return root;
	const visited = new WeakMap<object, object>();
	const stack = [open(root, "", visited)];
	const pathTo = (key: string) => () => stack.map((f) => f.segment).join("") + pointer(key);
	for (;;) {
		const frame = stack[stack.length - 1];
		let descended = false;
		while (frame.index < frame.entries.length) {
			const [key, desc] = frame.entries[frame.index++];
			const accessor = !("value" in desc);
			if ((accessor && !desc.get) || (!desc.enumerable && !frame.error)) continue;
			let child: unknown;
			try {
				child = accessor ? desc.get?.call(frame.value) : desc.value;
			} catch {
				// A getter that throws yields no value to any reader; leave it as it is.
				continue;
			}
			const sensitive =
				(isPrivateField(key) && isSecretBytes(child)) ||
				(frame.human && (key === "secretKey" || key === "sealedKey") && typeof child === "string");
			if (sensitive) settle(frame, key, desc, accessor, child, IDENTITY_MASK);
			else if (typeof child === "string") settle(frame, key, desc, accessor, child, filter(child, pathTo(key), key));
			else if (!isContainer(child)) settle(frame, key, desc, accessor, child, child);
			else {
				const previous = visited.get(child);
				if (previous) settle(frame, key, desc, accessor, child, previous);
				else {
					frame.pending = { key, desc, accessor, child };
					stack.push(open(child, pointer(key), visited));
					descended = true;
					break;
				}
			}
		}
		if (descended) continue;
		const result = close(frame, visited);
		stack.pop();
		const parent = stack[stack.length - 1];
		if (!parent?.pending) return result;
		const { key, desc, accessor, child } = parent.pending;
		parent.pending = undefined;
		settle(parent, key, desc, accessor, child, result);
	}
}

export function redactIdentityOutput<T>(value: T): T {
	return sanitize(value) as T;
}

/** Tool updates can be cumulative snapshots or incremental chunks. Never emit an undecided
 * suffix. Final results are separate complete values, not a reason to flush unverified bytes. */
export function identityUpdateFilter() {
	const blocks = new Map<string, { stream: IdentityOutputStream; previous: string; output: string }>();
	return <T>(frame: AgentToolResult<T>): AgentToolResult<T> => {
		return sanitize(frame, (text, pathOf, key) => {
			const path = pathOf();
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
