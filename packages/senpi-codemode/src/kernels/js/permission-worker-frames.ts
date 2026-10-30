import { MessagePort, type Transferable } from "node:worker_threads";

// Frames a host-observed cell Worker sends to its MessagePort proxy in the cell (permission-runtime.js).

/**
 * Runs inside a host-process listener, so it must not throw. A raw `parentPort` frame carries no transfer
 * list; its received MessagePorts are the only values that cannot be re-cloned, so they are transferred
 * onward as a native Worker would deliver them. A frame that still cannot be forwarded becomes the
 * cell Worker's `messageerror` event.
 */
export function forwardWorkerMessage(port: MessagePort, value: unknown, transfer: Transferable[]): void {
	const frame = { type: "message", value };
	try {
		port.postMessage(frame, transfer);
	} catch {
		try {
			port.postMessage(frame, [...new Set([...transfer, ...receivedPorts(value)])]);
		} catch (error) {
			const reason = error instanceof Error ? error : new Error(String(error));
			const failure = new Error(`Worker message could not be forwarded (${reason.name}): ${reason.message}`);
			port.postMessage({ type: "messageerror", error: failure });
		}
	}
}

/** Structured clone yields only plain containers, so ports can sit in arrays, objects, Maps and Sets. */
function receivedPorts(value: unknown): MessagePort[] {
	const ports: MessagePort[] = [];
	const seen = new Set<object>();
	const pending = [value];
	while (pending.length > 0) {
		const next = pending.pop();
		if (next === null || typeof next !== "object" || seen.has(next)) continue;
		seen.add(next);
		if (next instanceof MessagePort) ports.push(next);
		// Push one value at a time: spreading a collection past the engine's argument limit throws RangeError.
		else if (next instanceof Map) for (const [key, entry] of next) pending.push(key, entry);
		else if (next instanceof Set || Array.isArray(next)) for (const entry of next) pending.push(entry);
		else if (Object.getPrototypeOf(next) === Object.prototype)
			for (const entry of Object.values(next)) pending.push(entry);
	}
	return ports;
}

export function workerErrorFrame(value: unknown) {
	const error = value instanceof Error ? value : new Error(String(value));
	return {
		type: "error",
		error,
		message: error.message,
		filename: "fileName" in error ? error.fileName : "sourceURL" in error ? error.sourceURL : "",
		lineno: "lineNumber" in error ? error.lineNumber : "line" in error ? error.line : 0,
		colno: "columnNumber" in error ? error.columnNumber : "column" in error ? error.column : 0,
	};
}
