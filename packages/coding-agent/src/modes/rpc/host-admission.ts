/**
 * The public admission authority lives on the supervisor's loop. A ready probe is
 * informational: every open must still pass this gate, including on held sockets.
 */
export class HostAdmission {
	private stopped = false;
	private readonly listeners = new Set<() => Promise<void>>();
	private replies: Promise<void> = Promise.resolve();
	private info: Readonly<Record<string, unknown>>;

	constructor(info: Readonly<Record<string, unknown>>) {
		this.info = info;
	}

	get stopping(): boolean {
		return this.stopped;
	}

	protocol(): Readonly<Record<string, unknown>> {
		return { ...this.info, lifecycle: this.stopped ? "stopping" : "ready" };
	}

	observe(info: Readonly<Record<string, unknown>>): void {
		this.info = info;
	}

	/** Synchronous and monotonic; runs before any child signal or awaited teardown. */
	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.replies = Promise.all([...this.listeners].map((listener) => listener())).then(() => {});
	}

	/** Flush within the caller's existing five-second cleanup allowance; a stalled reader cannot pin exit. */
	async flush(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.replies,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 2_000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	onStop(listener: () => Promise<void>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

export function hostStoppingResponse(id: unknown, command: string, admission: HostAdmission): object {
	return {
		...(typeof id === "string" ? { id } : {}),
		type: "response",
		command,
		success: false,
		error: "host_stopping",
		errorCode: "host_stopping",
		errorData: { instanceId: admission.protocol().instanceId },
	};
}
