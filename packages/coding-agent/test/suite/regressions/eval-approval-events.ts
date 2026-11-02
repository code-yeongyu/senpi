export type ApprovalFrame = Readonly<Record<string, unknown>>;

export class ApprovalWaiterError extends Error {
	readonly name = "ApprovalWaiterError";
}

/** Test-owned wire history and event subscriptions, including failed-scenario teardown. */
export class ApprovalHostEvents {
	readonly client: ApprovalFrame[] = [];
	readonly stdout: ApprovalFrame[] = [];
	readonly #listeners = new Set<(frame: ApprovalFrame) => void>();
	readonly #cancelWaiters = new Set<() => void>();

	observe(line: string, destination: "client" | "stdout"): void {
		const frame: ApprovalFrame = JSON.parse(line);
		this[destination].push(frame);
		for (const listener of this.#listeners) listener(frame);
	}

	waitFor(predicate: (frame: ApprovalFrame) => boolean): Promise<ApprovalFrame> {
		const pending = new Promise<ApprovalFrame>((resolve, reject) => {
			const finish = (): void => {
				clearTimeout(timer);
				this.#listeners.delete(listener);
				this.#cancelWaiters.delete(cancel);
			};
			const cancel = (): void => {
				finish();
				reject(new ApprovalWaiterError("Host event waiter cancelled during teardown"));
			};
			const timer = setTimeout(() => {
				finish();
				reject(new ApprovalWaiterError("Host approval event did not arrive"));
			}, 30_000);
			const listener = (frame: ApprovalFrame): void => {
				if (!predicate(frame)) return;
				finish();
				resolve(frame);
			};
			this.#listeners.add(listener);
			this.#cancelWaiters.add(cancel);
		});
		// A scenario can fail before it awaits every subscribed event. Keep expected timeout/cancel
		// rejections handled, but return the original promise so awaiting it still fails the test.
		void pending.catch((error: unknown) => {
			if (!(error instanceof ApprovalWaiterError)) throw error;
		});
		return pending;
	}

	dispose(): void {
		for (const cancel of this.#cancelWaiters) cancel();
	}
}
