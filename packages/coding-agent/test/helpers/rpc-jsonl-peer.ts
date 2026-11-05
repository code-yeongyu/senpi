import type { Readable } from "node:stream";

import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";

export type RecordValue = Record<string, unknown>;
export class JsonlPeer {
	readonly messages: RecordValue[] = [];
	private readonly waiters = new Set<{
		predicate: (value: RecordValue) => boolean;
		resolve: (value: RecordValue) => void;
		reject: (cause: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	private readonly writeRaw: (line: string) => void;
	readonly detach: () => void;

	constructor(stream: Readable, writeRaw: (line: string) => void) {
		this.writeRaw = writeRaw;
		this.detach = attachJsonlLineReader(stream, (line) => this.record(JSON.parse(line) as RecordValue));
	}

	request(command: RecordValue, timeoutMs = 15_000): Promise<RecordValue> {
		const id = command.id;
		const response = this.waitFor((value) => value.type === "response" && value.id === id, timeoutMs);
		this.write(command);
		return response;
	}

	write(value: unknown): void {
		this.writeRaw(`${JSON.stringify(value)}\n`);
	}

	writeMalformed(line: string): void {
		this.writeRaw(`${line}\n`);
	}

	waitFor(predicate: (value: RecordValue) => boolean, timeoutMs = 15_000): Promise<RecordValue> {
		const existing = this.messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		const pending = new Promise<RecordValue>((resolve, reject) => {
			const waiter = {
				predicate,
				resolve,
				reject,
				timer: setTimeout(() => {
					this.waiters.delete(waiter);
					reject(new Error(`Timed out waiting for RPC record: ${JSON.stringify(this.messages)}`));
				}, timeoutMs),
			};
			this.waiters.add(waiter);
		});
		// Callers arm a waiter BEFORE the command that triggers it and await it only
		// after that command returns, so anything rejecting in between - the timeout
		// or close() during teardown - rejects a promise with no handler attached
		// yet. Node then reports an unhandled rejection blamed on whichever test
		// happened to be running when the timer fired. Marking the promise handled at
		// creation closes that window for good; the rejection still propagates to the
		// eventual awaiter, so failures are surfaced rather than swallowed.
		pending.catch(() => {});
		return pending;
	}

	close(): void {
		this.detach();
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("RPC peer closed"));
		}
		this.waiters.clear();
	}

	private record(value: RecordValue): void {
		this.messages.push(value);
		for (const waiter of [...this.waiters]) {
			if (!waiter.predicate(value)) continue;
			clearTimeout(waiter.timer);
			this.waiters.delete(waiter);
			waiter.resolve(value);
		}
	}
}
