import { createHarness, type Harness, type HarnessOptions } from "./suite/harness.ts";

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
}

export function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

export function createAutoTitleHarness(options: HarnessOptions = {}): Promise<Harness> {
	return createHarness({ ...options, persistSession: true, autoTitleSessions: true });
}

export function waitForSessionName(harness: Harness): Promise<string | undefined> {
	return new Promise((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "session_info_changed") {
				return;
			}
			unsubscribe();
			resolve(event.name);
		});
	});
}

export function waitForTitleError(harness: Harness): Promise<string> {
	return new Promise((resolve) => {
		harness.session.extensionRunner.onError((error) => {
			if (error.event === "session_title_generation") {
				resolve(error.error);
			}
		});
	});
}

export async function waitForCallCount(harness: Harness, expected: number): Promise<void> {
	const startedAt = Date.now();
	while (harness.faux.getCallLog().length < expected) {
		if (Date.now() - startedAt > 2_000) {
			throw new Error(`Timed out waiting for ${expected} faux calls`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
