/**
 * Decoded-frame timeline: connect-frame splitter + event-driven waiters.
 *
 * Feed raw client bytes; every complete 5-byte-prefixed Connect frame is
 * decoded into a timeline entry. `waitFor(pred, timeoutMs)` resolves on the
 * exact frame (no polling loop, no blind sleep) — feed() wakes matching
 * waiters synchronously, and a bound timer caps the wait.
 */

export class FrameLog {
	constructor(summarize) {
		this.summarize = summarize;
		this.entries = [];
		this.waiters = [];
		this.buffer = Buffer.alloc(0);
		this.t0 = Date.now();
		this.closed = null;
	}

	note(text) {
		this.entries.push({ i: this.entries.length, tMs: Date.now() - this.t0, case: "serverNote", note: text });
	}

	feed(chunk) {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length >= 5) {
			const flags = this.buffer[0];
			const length = this.buffer.readUInt32BE(1);
			if (this.buffer.length < 5 + length) break;
			const bytes = this.buffer.subarray(5, 5 + length);
			this.buffer = this.buffer.subarray(5 + length);
			let summary;
			try {
				summary = flags & 0b10 ? { case: "endStream" } : this.summarize(bytes);
			} catch (error) {
				summary = { case: "undecodable", error: String(error).slice(0, 120) };
			}
			this.entries.push({ i: this.entries.length, tMs: Date.now() - this.t0, flags, ...summary });
		}
		this.#wake();
	}

	/** Resolve the first entry matching pred, waiting for it if needed. */
	async waitFor(pred, timeoutMs, label) {
		const found = this.entries.find(pred);
		if (found) return found;
		if (this.closed) throw new Error(`${label}: stream already closed (${this.closed})`);
		return new Promise((resolve, reject) => {
			const waiter = {
				pred,
				resolve,
				timer: setTimeout(() => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					const tail = this.entries.slice(-4).map((e) => `${e.case}${e.control ?? ""}${e.message ?? ""}`).join(", ");
					reject(new Error(`${label}: timed out after ${timeoutMs}ms waiting for a decoded frame (tail: ${tail})`));
				}, timeoutMs),
			};
			this.waiters.push(waiter);
		});
	}

	all(pred) {
		return this.entries.filter(pred);
	}

	/** Fail every pending waiter once the transport is gone. */
	close(reason) {
		if (this.closed) return;
		this.closed = reason;
		for (const waiter of this.waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error(`${reason}`));
		}
	}

	#wake() {
		for (const waiter of [...this.waiters]) {
			const hit = this.entries.find(waiter.pred);
			if (!hit) continue;
			clearTimeout(waiter.timer);
			this.waiters.splice(this.waiters.indexOf(waiter), 1);
			waiter.resolve(hit);
		}
	}
}
