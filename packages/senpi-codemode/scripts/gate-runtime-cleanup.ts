interface RuntimeCleanup {
	readonly retireKernel: () => Promise<void>;
	readonly closeBridge: () => Promise<void>;
	readonly restoreObservers: () => void;
	readonly removeRoot: () => Promise<void>;
}

/** Cleanup failures must not prevent the other owned resources from retiring. */
export async function cleanupRuntime(actions: RuntimeCleanup): Promise<void> {
	const shutdown = await Promise.allSettled(
		[actions.retireKernel, actions.closeBridge]
			.map((action) => Promise.resolve().then(action)),
	);
	const finalizers = await Promise.allSettled(
		[actions.restoreObservers, actions.removeRoot]
			.map((action) => Promise.resolve().then(action)),
	);
	const failures: unknown[] = [];
	for (const result of [...shutdown, ...finalizers]) {
		switch (result.status) {
			case "fulfilled":
				break;
			case "rejected":
				failures.push(result.reason);
				break;
			default: {
				const unreachable: never = result;
				throw new TypeError(String(unreachable));
			}
		}
	}
	if (failures.length > 0) {
		const details = failures.map((error) => error instanceof Error ? error.message : String(error));
		throw new AggregateError(failures, `Runtime cleanup failed: ${details.join("; ")}`);
	}
}
