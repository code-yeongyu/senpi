/**
 * Places a session's lifecycle events in its event stream by cause (senpi#4360, R10.c). The lifecycle state updates
 * synchronously when an agent event arrives, but the session delivers that agent event later, through its ordered
 * queue. A lifecycle event emitted while the session handles an agent event is held and delivered immediately before
 * that event in the same queue, so its position no longer depends on how fast either side runs. A lifecycle event
 * raised outside that window (holds, settles, startup) is delivered at once, unless held events are still waiting in
 * the queue: then it joins the queue's tail, so a newer snapshot never reaches a listener before an older one.
 */
export class LifecycleEventSequencer<Event> {
	#held: Event[] | undefined;
	/** Lifecycle events already placed in the session's queue and not yet delivered. */
	#queued = 0;

	emit(event: Event, deliver: (event: Event) => void, enqueue: (run: () => void) => void): void {
		if (this.#held !== undefined) {
			this.#held.push(event);
		} else if (this.#queued > 0) {
			this.#queued++;
			enqueue(() => {
				this.#queued--;
				deliver(event);
			});
		} else {
			deliver(event);
		}
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
		this.#queued += held.length;
		return held;
	}

	/** Delivers the events {@link hold} returned, from the session's queue. */
	release(held: readonly Event[], deliver: (event: Event) => void): void {
		this.#queued -= held.length;
		for (const event of held) deliver(event);
	}
}
