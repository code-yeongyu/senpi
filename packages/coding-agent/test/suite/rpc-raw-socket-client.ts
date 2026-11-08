import { once } from "node:events";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { z } from "zod";

// The shared endpoint schema types `data.state` as a session snapshot and `message` as text; a warm, a model turn
// or a permission-mode echo send neither, so these suites read the socket's JSON lines themselves.
export type RawRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };

export type RawClient = Awaited<ReturnType<typeof rawClient>>;

export async function rawClient(socketPath: string) {
	const socket = createConnection(socketPath);
	await once(socket, "connect", { signal: AbortSignal.timeout(10_000) });
	const records: RawRecord[] = [];
	const waiters = new Set<(record: RawRecord) => void>();
	createInterface({ input: socket }).on("line", (line) => {
		const record = z.record(z.string(), z.unknown()).parse(JSON.parse(line)) as RawRecord;
		records.push(record);
		for (const waiter of [...waiters]) waiter(record);
	});
	let serial = 0;
	const wait = (predicate: (record: RawRecord) => boolean, ms = 60_000): Promise<RawRecord> =>
		new Promise((resolve, reject) => {
			const seen = records.find(predicate);
			if (seen) return resolve(seen);
			const timer = setTimeout(() => {
				waiters.delete(waiter);
				reject(new Error(`deadline waiting on the socket: ${String(predicate).slice(0, 120)}`));
			}, ms);
			const waiter = (record: RawRecord): void => {
				if (!predicate(record)) return;
				clearTimeout(timer);
				waiters.delete(waiter);
				resolve(record);
			};
			waiters.add(waiter);
		});
	return {
		records,
		wait,
		send(command: Record<string, unknown>): void {
			socket.write(`${JSON.stringify(command)}\n`);
		},
		async request(command: Record<string, unknown>): Promise<RawRecord> {
			const id = `raw-${++serial}`;
			const response = wait((record) => record.type === "response" && record.id === id);
			socket.write(`${JSON.stringify({ ...command, id })}\n`);
			return response;
		},
		close(): void {
			socket.destroy();
		},
	};
}
