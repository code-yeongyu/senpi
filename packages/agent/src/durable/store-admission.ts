/** The single admission line above a DurableStore: mutations run one at a time, in admission order. */
export interface AdmissionLine {
	/** Run `mutation` after every earlier admission settles. A rejected mutation releases the line. */
	admit<T>(mutation: () => Promise<T>): Promise<T>;
}

export function createAdmissionLine(): AdmissionLine {
	let tail: Promise<void> = Promise.resolve();
	return {
		admit<T>(mutation: () => Promise<T>): Promise<T> {
			const run = tail.then(() => mutation());
			tail = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
	};
}
