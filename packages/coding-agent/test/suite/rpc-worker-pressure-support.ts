import { EventEmitter, once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const PRESSURE_BYTES = 8 * 1024 * 1024;
export const pressureExtension = `export default function (pi) {
	pi.registerCommand("pressure", { description: "test pipe credit", handler: async (args, ctx) => {
		for (let sequence = 0; sequence < 2; sequence++)
			ctx.ui.notify("PRESSURE_PAYLOAD:" + args + ":" + sequence + ":" + "p".repeat(${PRESSURE_BYTES}), "info");
	} });
}`;

/** Observation only: original writes, returns, callbacks, drain events and enqueue methods are unchanged. */
export function pressurePreload(): string {
	const writerModule = pathToFileURL(resolve("dist/modes/rpc/session-event-writer.js")).href;
	const clientModule = pathToFileURL(resolve("dist/modes/rpc/session-worker-client.js")).href;
	return `import { Socket } from "node:net";
import { SessionEventWriter } from ${JSON.stringify(writerModule)};
import { SessionWorkerClient } from ${JSON.stringify(clientModule)};
const streams = new Map();
const sessions = new Map();
const credits = new Map();
const receive = SessionWorkerClient.prototype.receive;
SessionWorkerClient.prototype.receive = function (message) {
	const match = message.type === "output" && typeof message.record.message === "string" && message.record.message.match(/^PRESSURE_PAYLOAD:(\\d+):/);
	if (match) credits.set(Number(match[1]), message.signal);
	return Reflect.apply(receive, this, [message]);
};
const state = (socket, phase) => ({ pid: process.pid, needDrain: socket.writableNeedDrain, pendingBytes: socket.writableLength, credit: Atomics.load(new Int32Array(credits.get(phase)), 0) });
const signal = (kind, phase, value) => process.stderr.write("PRESSURE_" + kind + ":" + phase + " " + JSON.stringify(value) + "\\n");
const write = Socket.prototype.write;
Socket.prototype.write = function (chunk, ...args) {
	const match = typeof chunk === "string" && chunk.match(/PRESSURE_PAYLOAD:(\\d+):(\\d+):/);
	if (!match || this === process.stderr) return Reflect.apply(write, this, [chunk, ...args]);
	const phase = Number(match[1]);
	streams.set(phase, this);
	sessions.set(JSON.parse(chunk).sessionId, phase);
	const drained = () => signal("DRAIN", phase, state(this, phase));
	this.once("drain", drained);
	let accepted;
	try { accepted = Reflect.apply(write, this, [chunk, ...args]); }
	catch (error) { this.off("drain", drained); throw error; }
	if (accepted) this.off("drain", drained);
	else signal("BLOCKED", phase, { ...state(this, phase), sequence: Number(match[2]) });
	return accepted;
};
const enqueue = SessionEventWriter.prototype.enqueueControl;
SessionEventWriter.prototype.enqueueControl = function (record) {
	const result = Reflect.apply(enqueue, this, [record]);
	if (typeof record.id === "string" && record.id.startsWith("pressure-probe:")) {
		const phase = Number(record.id.split(":")[1]);
		signal("PROBE", phase, { ...state(streams.get(phase), phase), bufferedRecords: this.bufferedRecordCount, bufferedBytes: this.bufferedByteLength });
	}
	return result;
};
const close = SessionEventWriter.prototype.closeSession;
SessionEventWriter.prototype.closeSession = function (sessionId, response) {
	const result = Reflect.apply(close, this, [sessionId, response]);
	const phase = sessions.get(sessionId);
	if (phase !== undefined) signal("TERMINAL", phase, { ...state(streams.get(phase), phase), bufferedRecords: this.bufferedRecordCount, bufferedBytes: this.bufferedByteLength });
	return result;
};`;
}

const pressureState = z.object({
	pid: z.number(),
	needDrain: z.boolean(),
	pendingBytes: z.number(),
	credit: z.number(),
	sequence: z.number().optional(),
	bufferedRecords: z.number().optional(),
	bufferedBytes: z.number().optional(),
});

export function observePressure(input: Readable) {
	const events = new EventEmitter();
	const abort = new AbortController();
	const lines = createInterface({ input });
	lines.on("line", (line) => {
		if (!line.startsWith("PRESSURE_")) return;
		const separator = line.indexOf(" ");
		events.emit(line.slice(0, separator), line.slice(separator + 1));
	});
	return {
		async wait(kind: "BLOCKED" | "PROBE" | "DRAIN" | "TERMINAL", phase: number) {
			const [raw] = await once(events, `PRESSURE_${kind}:${phase}`, {
				signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
			});
			return pressureState.parse(JSON.parse(z.string().parse(raw)));
		},
		dispose() {
			abort.abort();
			lines.close();
		},
	};
}
