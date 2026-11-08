/** One test client of the delegated host fixture: sends records, correlates answers by id, watches frames. */
import type { Socket } from "node:net";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";

export type WireRecord = Record<string, unknown>;

export const ANSWER_DEADLINE_MS = 20_000;

export class Peer {
	private readonly answers = new Map<string, (record: WireRecord) => void>();
	private readonly frames: WireRecord[] = [];
	private readonly watchers = new Set<(record: WireRecord) => void>();
	private serial = 0;
	readonly socket: Socket;
	readonly name: string;
	/** The id the host registered this socket under (`socket-N`), for host-side mechanism reads. */
	readonly connectionId: string;

	constructor(socket: Socket, name: string, connectionId = "") {
		this.socket = socket;
		this.name = name;
		this.connectionId = connectionId;
		attachJsonlLineReader(socket, (line) => {
			const record = JSON.parse(line) as WireRecord;
			if (record.type === "response" && typeof record.id === "string") this.answers.get(record.id)?.(record);
			this.frames.push(record);
			for (const watch of this.watchers) watch(record);
		});
	}

	nextId(): string {
		return `${this.name}-${++this.serial}`;
	}

	send(record: WireRecord): Promise<WireRecord> {
		const id = typeof record.id === "string" ? record.id : this.nextId();
		const answered = this.answer(id, String(record.type));
		this.socket.write(`${JSON.stringify({ ...record, id })}\n`);
		return answered;
	}

	/** Writes several records in ONE socket write, so the host decides them in line order; resolves every answer. */
	sendTogether(records: readonly WireRecord[]): Promise<WireRecord>[] {
		const stamped: Array<WireRecord & { readonly id: string }> = records.map((record) => ({
			...record,
			id: typeof record.id === "string" ? record.id : this.nextId(),
		}));
		const answers = stamped.map((record) => this.answer(record.id, String(record.type)));
		this.socket.write(stamped.map((record) => `${JSON.stringify(record)}\n`).join(""));
		return answers;
	}

	/** True while `id` was sent and no response to it has arrived. */
	pending(id: string): boolean {
		return this.answers.has(id);
	}

	/**
	 * For a record the host may answer with nothing (an answer to a dialog nobody raised): resolves with its response if
	 * one precedes the answer to a `get_protocol_info` sent right behind it on this connection, else `undefined`.
	 */
	async sendSettled(record: WireRecord): Promise<WireRecord | undefined> {
		const id = this.nextId();
		let answer: WireRecord | undefined;
		this.answers.set(id, (response) => {
			answer = response;
		});
		this.socket.write(`${JSON.stringify({ ...record, id })}\n`);
		const sentinel = this.send({ type: "get_protocol_info", observe: true });
		await sentinel;
		this.answers.delete(id);
		return answer;
	}

	answer(id: string, type = "record"): Promise<WireRecord> {
		return new Promise<WireRecord>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`${this.name}: no answer to ${type} ${id}`)),
				ANSWER_DEADLINE_MS,
			);
			this.answers.set(id, (record) => {
				clearTimeout(timer);
				this.answers.delete(id);
				resolve(record);
			});
		});
	}

	/** Calls `watch` with every frame parsed from now on; returns the unsubscribe. */
	subscribe(watch: (record: WireRecord) => void): () => void {
		this.watchers.add(watch);
		return () => this.watchers.delete(watch);
	}

	frame(predicate: (record: WireRecord) => boolean): Promise<WireRecord> {
		const seen = this.frames.find(predicate);
		if (seen) return Promise.resolve(seen);
		return new Promise<WireRecord>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.watchers.delete(watch);
				reject(new Error(`${this.name}: no matching frame`));
			}, ANSWER_DEADLINE_MS);
			const watch = (record: WireRecord) => {
				if (!predicate(record)) return;
				clearTimeout(timer);
				this.watchers.delete(watch);
				resolve(record);
			};
			this.watchers.add(watch);
		});
	}
}
