type StructuredReceiver = (record: object) => void;

/**
 * Per-session receivers of the internal structured lane (senpi#4272): the host-side owner of seeded records and
 * block controls (S03/S04) registers here. Legacy sockets, stdout and the replay snapshot never read it.
 */
export class SessionStructuredLanes {
	private readonly receivers = new Map<string, Set<StructuredReceiver>>();

	observe(sessionId: string, receiver: StructuredReceiver): () => void {
		const receivers = this.receivers.get(sessionId) ?? new Set<StructuredReceiver>();
		receivers.add(receiver);
		this.receivers.set(sessionId, receivers);
		return () => {
			receivers.delete(receiver);
			if (receivers.size === 0 && this.receivers.get(sessionId) === receivers) this.receivers.delete(sessionId);
		};
	}

	accept(sessionId: string, record: object): void {
		for (const receiver of [...(this.receivers.get(sessionId) ?? [])]) receiver(record);
	}
}
