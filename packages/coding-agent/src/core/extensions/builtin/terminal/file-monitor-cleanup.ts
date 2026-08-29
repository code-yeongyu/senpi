function reportFileMonitorError(error: Error): void {
	console.error("Native file monitor callback failed.", error);
}

export function runFileMonitorAsyncBoundary(action: () => void, onError = reportFileMonitorError): void {
	try {
		action();
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		try {
			onError(failure);
		} catch (reportError) {
			reportFileMonitorError(reportError instanceof Error ? reportError : new Error(String(reportError)));
		}
	}
}

export function runAllCleanup(actions: ReadonlyArray<() => void>): void {
	const errors: Error[] = [];
	for (const action of actions) {
		try {
			action();
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, "File monitor cleanup failed.");
}

export async function runAllAsyncCleanup(actions: ReadonlyArray<() => void | Promise<void>>): Promise<void> {
	const errors: Error[] = [];
	for (const action of actions) {
		try {
			await action();
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, "Terminal session cleanup failed.");
}
