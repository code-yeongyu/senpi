import { serializeJsonLine } from "./jsonl.ts";

type RpcRecord = Record<string, unknown>;

export type QueueNode = {
	value: RpcRecord;
	line: string;
	byteLength: number;
	key?: string;
	previous?: QueueNode;
	next?: QueueNode;
	resolve?: () => void;
	reject?: (cause: unknown) => void;
};

export type RecordQueue = {
	sessionId?: string;
	targetId?: string;
	head?: QueueNode;
	tail?: QueueNode;
	latestByKey: Map<string, QueueNode>;
	ready: boolean;
};

/** Linked-queue mutations own the retained totals; in-flight records are counted by the writer. */
export class SessionRecordAccounting {
	count = 0;
	bytes = 0;

	append(
		queue: RecordQueue,
		value: RpcRecord,
		key?: string,
		resolve?: () => void,
		reject?: (cause: unknown) => void,
	): QueueNode {
		const line = serializeJsonLine(value);
		const byteLength = Buffer.byteLength(line);
		const node: QueueNode = { value, line, byteLength, key, previous: queue.tail, resolve, reject };
		if (queue.tail) queue.tail.next = node;
		else queue.head = node;
		queue.tail = node;
		this.count++;
		this.bytes += byteLength;
		return node;
	}

	replace(node: QueueNode, value: RpcRecord): void {
		const line = serializeJsonLine(value);
		const byteLength = Buffer.byteLength(line);
		this.bytes += byteLength - node.byteLength;
		node.value = value;
		node.line = line;
		node.byteLength = byteLength;
	}

	unlink(queue: RecordQueue, node: QueueNode): void {
		if (node.previous) node.previous.next = node.next;
		else queue.head = node.next;
		if (node.next) node.next.previous = node.previous;
		else queue.tail = node.previous;
		if (node.key && queue.latestByKey.get(node.key) === node) queue.latestByKey.delete(node.key);
		node.previous = undefined;
		node.next = undefined;
		this.count--;
		this.bytes -= node.byteLength;
	}
}
