/**
 * One JSONL socket connection to a running RPC host, for the load drivers.
 *
 * Correlated requests (the host answers a session command through the event
 * stream, not from the write call), plus a per-session record tap so a driver
 * can time the first event of a turn and wait for its settlement.
 */
import { createConnection } from "node:net";

export async function connectJsonlSocket(socketPath, budgetMs = 120_000) {
	const socket = createConnection(socketPath);
	await new Promise((ready, fail) => {
		socket.once("connect", ready);
		socket.once("error", fail);
	});
	let serial = 0;
	let buffer = "";
	const pending = new Map();
	const taps = new Set();
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const record = JSON.parse(line);
			if (record.id && pending.has(record.id)) {
				pending.get(record.id)(record);
				pending.delete(record.id);
				continue;
			}
			if (!record.sessionId) continue;
			for (const tap of [...taps]) if (tap.sessionId === record.sessionId) tap.accept(record);
		}
	});

	const request = (command) => {
		const id = `load-${++serial}`;
		const started = performance.now();
		const answered = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`No response for ${command.type} (${id})`)), budgetMs);
			pending.set(id, (record) => {
				clearTimeout(timer);
				resolve({ ...record, elapsedMs: Number((performance.now() - started).toFixed(2)) });
			});
		});
		socket.write(`${JSON.stringify({ ...command, id })}\n`);
		return answered;
	};

	const waitForRecord = (sessionId, accepts) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				taps.delete(tap);
				reject(new Error(`No matching record from ${sessionId}`));
			}, budgetMs);
			const tap = {
				sessionId,
				accept: (record) => {
					if (!accepts(record)) return;
					clearTimeout(timer);
					taps.delete(tap);
					resolve(record);
				},
			};
			taps.add(tap);
		});

	return {
		request,
		waitForRecord,
		/** Milliseconds from issuing the prompt to that session's first streamed record. */
		async timeToFirstEvent(sessionId, message) {
			const started = performance.now();
			const first = waitForRecord(sessionId, () => true).then(() => performance.now() - started);
			const response = await request({ type: "prompt", sessionId, message });
			if (response.success !== true) throw new Error(`prompt failed: ${JSON.stringify(response)}`);
			return first;
		},
		dispose: () => socket.destroy(),
	};
}
