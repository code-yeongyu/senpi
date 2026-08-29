function reportFileMonitorError(error: Error): void {
	console.error("Native file monitor callback failed.", error);
}

function reportBoundaryError(error: unknown, onError: (error: Error) => void): void {
	const failure = error instanceof Error ? error : new Error(String(error));
	try {
		onError(failure);
	} catch (reportError) {
		reportFileMonitorError(reportError instanceof Error ? reportError : new Error(String(reportError)));
	}
}

export function runFileMonitorAsyncBoundary(action: () => void, onError = reportFileMonitorError): void {
	try {
		action();
	} catch (error) {
		reportBoundaryError(error, onError);
	}
}

export function runFileMonitorPromiseBoundary(action: () => Promise<void>, onError = reportFileMonitorError): void {
	void action().catch((error) => reportBoundaryError(error, onError));
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
