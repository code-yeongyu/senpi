import { once } from "node:events";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

const fauxPath = fileURLToPath(new URL("../../../ai/src/providers/faux.ts", import.meta.url));
const extension = `
import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(fauxPath)};
export default function (pi) {
	const stringify = JSON.stringify;
	let workerBytes = 0;
	let sessionBytes = 0;
	JSON.stringify = function(value, ...args) {
		const line = stringify(value, ...args);
		if (value?.type === "message_update" && value.sessionId) {
			// Classify by the whole stack: the default 10-frame limit can cut off the worker frame.
			const limit = Error.stackTraceLimit;
			Error.stackTraceLimit = Infinity;
			const stack = new Error().stack;
			Error.stackTraceLimit = limit;
			if (stack.includes("/session-worker.ts:") || stack.includes("/session-worker.js:")) workerBytes += Buffer.byteLength(line);
			else sessionBytes += Buffer.byteLength(line);
		}
		return line;
	};
	const faux = fauxProvider({ tokenSize: { min: 4, max: 4 } });
	faux.setResponses([fauxAssistantMessage("x".repeat(16 * 1024), { timestamp: 1 })]);
	pi.registerProvider(faux.provider);
	pi.on("agent_end", () => pi.rpc.emit("s01.x07", { workerBytes, sessionBytes }));
	pi.registerCommand("records", {
		description: "Emit JSON edge cases",
		handler: async () => {
			pi.rpc.emit("s01.record", { index: 0, fn() {}, absent: undefined, nan: NaN });
			pi.rpc.emit("s01.record", { index: 1, value: { toJSON() { return { wire: "json" }; } } });
			pi.rpc.emit("s01.record", Object.assign(Object.create({ inherited: "ignored" }), { index: 2, own: "kept" }));
		},
	});
}`;

// Part of #4272: one real isolate uses the same JSON-normal transfer for every record.
it("preserves worker record order and bytes for non-cloneable JSON inputs and streaming deltas", async () => {
	const host = await startWorkerHost(extension, { socket: true });
	const socket = createConnection(host.socketPath);
	const lines: string[] = [];
	const listeners = new Set<(record: Record<string, unknown>) => void>();
	let partial = "";
	const capture = (chunk: Buffer) => {
		partial += chunk.toString();
		const frames = partial.split("\n");
		partial = frames.pop() ?? "";
		lines.push(...frames);
		for (const line of frames) {
			const record: Record<string, unknown> = JSON.parse(line);
			for (const listener of [...listeners]) listener(record);
		}
	};
	socket.on("data", capture);
	const next = (predicate: (record: Record<string, unknown>) => boolean) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				listeners.delete(listener);
				reject(new Error(`Structured worker deadline: ${host.stderrText()}`));
			}, 30_000);
			const listener = (record: Record<string, unknown>) => {
				if (!predicate(record)) return;
				clearTimeout(timer);
				listeners.delete(listener);
				resolve(record);
			};
			listeners.add(listener);
		});
	let serial = 0;
	const request = (command: object) => {
		const id = `s01-${++serial}`;
		const response = next((record) => record.type === "response" && record.id === id);
		socket.write(`${JSON.stringify({ ...command, id })}\n`);
		return response;
	};
	try {
		await once(socket, "connect", { signal: AbortSignal.timeout(10_000) });
		await request({ type: "set_client_info", capabilities: ["extension_events"] });
		const opened = await request({ type: "open_session", cwd: host.cwd, provider: "faux", modelId: "faux-1" });
		expect(opened.success, String(opened.error)).toBe(true);
		const sessionId = String((opened.data as { sessionId: string }).sessionId);
		const emitted = next(
			(record) => record.type === "extension_event" && (record.data as { index?: number })?.index === 2,
		);
		expect((await request({ type: "prompt", sessionId, message: "/records" })).success).toBe(true);
		await emitted;
		const expected = [
			{ index: 0, nan: null },
			{ index: 1, value: { wire: "json" } },
			{ index: 2, own: "kept" },
		].map((data) => JSON.stringify({ type: "extension_event", name: "s01.record", data, sessionId }));
		expect(lines.filter((line) => line.includes('"name":"s01.record"'))).toEqual(expected);

		const settled = next((record) => record.type === "agent_settled" && record.sessionId === sessionId);
		const measured = next((record) => record.type === "extension_event" && record.name === "s01.x07");
		expect((await request({ type: "prompt", sessionId, message: "stream" })).success).toBe(true);
		await settled;
		const updates = lines
			.map((line): Record<string, unknown> => JSON.parse(line))
			.filter((record) => record.type === "message_update");
		const deltas = updates.filter(
			(record) => (record.assistantMessageEvent as { type: string }).type === "text_delta",
		);
		expect(deltas).toHaveLength(1024);
		expect(deltas.map((record) => (record.assistantMessageEvent as { delta: string }).delta).join("")).toBe(
			"x".repeat(16 * 1024),
		);
		expect(updates.every((record) => record.sessionId === sessionId)).toBe(true);
		const metrics = (await measured).data as { workerBytes: number; sessionBytes: number };
		console.log(`X07_WORKER ${JSON.stringify(metrics)}`);
		expect(metrics.workerBytes).toBeGreaterThan(0);
		expect(metrics.sessionBytes).toBe(0);
		const last = await request({ type: "get_last_assistant_text", sessionId });
		expect((last.data as { text: string }).text).toBe("x".repeat(16 * 1024));
	} finally {
		socket.destroy();
		await host.dispose();
	}
}, 90_000);
