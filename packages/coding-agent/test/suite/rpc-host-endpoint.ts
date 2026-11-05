import type { Readable, Writable } from "node:stream";
import { z } from "zod";

const recordSchema = z
	.object({
		type: z.string(),
		id: z.string().optional(),
		command: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
		success: z.boolean().optional(),
		error: z.string().optional(),
		message: z.string().optional(),
		sessionId: z.string().optional(),
		data: z
			.object({
				sessionId: z.string().optional(),
				sessionFile: z.string().optional(),
				attached: z.boolean().optional(),
				state: z.object({ sessionId: z.string(), sessionFile: z.string().optional() }).passthrough().optional(),
				sessions: z
					.array(
						// Passthrough: a suite asserting an additive row field (kind, context) must see
						// what the host sent, not a copy this fixture silently stripped.
						z
							.object({
								sessionId: z.string(),
								status: z.string(),
								sessionPath: z.string().optional(),
								attachments: z.number().optional(),
							})
							.passthrough(),
					)
					.optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();
export type WorkerHostRecord = z.infer<typeof recordSchema>;

export function endpoint(input: Readable, output: Writable, diagnostic: () => string) {
	let serial = 0;
	const records: WorkerHostRecord[] = [];
	const listeners = new Set<{ accept: (record: WorkerHostRecord) => void; reject: (error: Error) => void }>();
	let buffered = "";
	let terminalError: Error | undefined;
	const fail = (error: Error) => {
		terminalError ??= error;
		for (const listener of [...listeners]) listener.reject(terminalError);
	};
	const acceptLine = (line: string) => {
		try {
			const record = recordSchema.parse(JSON.parse(line));
			records.push(record);
			if (records.length > 512) records.shift();
			for (const listener of [...listeners]) listener.accept(record);
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			for (const listener of [...listeners]) listener.reject(error);
		}
	};
	const onData = (chunk: string) => {
		buffered += chunk;
		let newline = buffered.indexOf("\n");
		while (newline !== -1) {
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			acceptLine(line);
			newline = buffered.indexOf("\n");
		}
	};
	const onEnd = () => fail(new Error(`RPC stream closed before expected record; ${diagnostic()}`));
	input.setEncoding("utf8");
	input.on("data", onData);
	input.on("end", onEnd);
	input.on("close", onEnd);
	input.on("error", fail);
	output.on("error", fail);
	function wait(predicate: (record: WorkerHostRecord) => boolean, ms = 30_000): Promise<WorkerHostRecord> {
		if (terminalError) return Promise.reject(terminalError);
		return new Promise((resolveRecord, reject) => {
			const finish = () => {
				clearTimeout(timer);
				listeners.delete(listener);
			};
			const listener = {
				accept(record: WorkerHostRecord) {
					if (predicate(record)) {
						finish();
						resolveRecord(record);
					}
				},
				reject(error: Error) {
					finish();
					reject(error);
				},
			};
			// Name the awaited record: a bare deadline plus host stderr reads like a
			// transport stall even when the host is healthy and the record simply never
			// matched, which is how a contract drift once looked like socket backpressure.
			const awaited = String(predicate).replace(/\s+/g, " ").slice(0, 200);
			const timer = setTimeout(
				() => listener.reject(new Error(`RPC deadline waiting for ${awaited}; ${diagnostic()}`)),
				ms,
			);
			listeners.add(listener);
		});
	}
	return {
		records,
		wait,
		pauseReading: () => input.pause(),
		resumeReading: () => input.resume(),
		send(command: Record<string, unknown>) {
			output.write(`${JSON.stringify(command)}\n`);
		},
		request(command: Record<string, unknown>, ms?: number) {
			const id = `worker-test-${++serial}`;
			const response = wait((record) => record.type === "response" && record.id === id, ms);
			output.write(`${JSON.stringify({ ...command, id })}\n`);
			return response;
		},
		dispose() {
			for (const listener of [...listeners]) listener.reject(new Error("Test endpoint disposed"));
			input.off("data", onData);
			input.off("end", onEnd);
			input.off("close", onEnd);
			input.off("error", fail);
			output.off("error", fail);
			buffered = "";
		},
	};
}
