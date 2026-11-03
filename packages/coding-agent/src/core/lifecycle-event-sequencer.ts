/**
 * Places a session's lifecycle events in its event stream by cause (senpi#4360, R10.c). The lifecycle state updates
 * synchronously when an agent event arrives, but the session delivers that agent event later, through its ordered
 * queue. A lifecycle event emitted while the session handles an agent event is held and delivered immediately before
 * that event in the same queue, so its position no longer depends on how fast either side runs. Lifecycle events
 * raised outside that window (holds, settles, startup) are delivered at once, as before.
 */
export class LifecycleEventSequencer<Event> {
	#held: Event[] | undefined;

	emit(event: Event, deliver: (event: Event) => void): void {
		if (this.#held === undefined) deliver(event);
		else this.#held.push(event);
	}

	hold(handle: () => void, deliver: (event: Event) => void): readonly Event[] {
		const outer = this.#held;
		const held: Event[] = [];
		this.#held = held;
		try {
			handle();
		} catch (error) {
			this.#held = outer;
			for (const event of held) deliver(event);
			throw error;
		}
		this.#held = outer;
		return held;
	}
}
