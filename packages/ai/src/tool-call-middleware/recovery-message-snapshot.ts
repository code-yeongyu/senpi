import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "../types.ts";

function isPlainObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function clonePlainGraph<T>(value: T, seen: WeakMap<object, unknown>): T {
	if (typeof value !== "object" || value === null) return value;
	const existing = seen.get(value);
	if (existing !== undefined) return existing as T;
	if (Array.isArray(value)) {
		const clone: unknown[] = new Array(value.length);
		seen.set(value, clone);
		for (const key of Object.keys(value)) {
			Object.defineProperty(clone, key, {
				value: clonePlainGraph(Reflect.get(value, key), seen),
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		return clone as T;
	}
	if (!isPlainObject(value)) return value;
	const clone = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
	seen.set(value, clone);
	for (const key of Object.keys(value)) {
		Object.defineProperty(clone, key, {
			value: clonePlainGraph(Reflect.get(value, key), seen),
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
	return clone as T;
}

function removeToolScratch(toolCall: ToolCall): void {
	delete (toolCall as ToolCall & { partialJson?: string }).partialJson;
}

function sanitizeMessage(message: AssistantMessage): void {
	for (const block of message.content) {
		if (block.type === "toolCall") removeToolScratch(block);
	}
}

/** Deep-clones enumerable plain message/event state while retaining exotic values by reference. */
export function snapshotRecoveryEvent(event: AssistantMessageEvent): AssistantMessageEvent {
	const snapshot = clonePlainGraph(event, new WeakMap());
	if (snapshot.type === "done") sanitizeMessage(snapshot.message);
	else if (snapshot.type === "error") sanitizeMessage(snapshot.error);
	else {
		sanitizeMessage(snapshot.partial);
		if (snapshot.type === "toolcall_end") removeToolScratch(snapshot.toolCall);
	}
	return snapshot;
}
