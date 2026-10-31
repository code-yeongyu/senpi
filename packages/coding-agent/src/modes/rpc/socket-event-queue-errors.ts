export class SocketEventQueueStallError extends Error {
	readonly pendingBytes: number;
	readonly stallMs: number;

	constructor(pendingBytes: number, stallMs: number) {
		super(`socket event queue stalled: peer did not drain ${pendingBytes} queued bytes within ${stallMs}ms`);
		this.name = "SocketEventQueueStallError";
		this.pendingBytes = pendingBytes;
		this.stallMs = stallMs;
	}
}

export class SocketEventQueueOverflowError extends Error {
	readonly queuedBytes: number;
	readonly incomingBytes: number;
	readonly maxQueueBytes: number;
	readonly incomingPreview: string;

	constructor(queuedBytes: number, incomingBytes: number, maxQueueBytes: number, incomingPreview: string) {
		super(
			`socket event queue overflow: ${queuedBytes} queued + ${incomingBytes} incoming > ${maxQueueBytes} (incoming: ${incomingPreview})`,
		);
		this.name = "SocketEventQueueOverflowError";
		this.queuedBytes = queuedBytes;
		this.incomingBytes = incomingBytes;
		this.maxQueueBytes = maxQueueBytes;
		this.incomingPreview = incomingPreview;
	}
}
