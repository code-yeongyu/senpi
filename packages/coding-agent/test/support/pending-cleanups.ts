/**
 * Teardown work started by test fixtures that most callers do not await (the suite harness `cleanup()`, senpi#6488).
 * Each recorded promise gets a no-op handler at once, so an unawaited failure is never an unhandled rejection, and
 * `joinPendingCleanups` (registered as an afterEach/afterAll hook by `test/setup.ts`) waits for all of them and
 * rethrows the first failure, failing the test that left it behind. Kept free of vitest so code that imports a fixture
 * outside a test run (the benchmarks) can still load it.
 */
const pendingCleanups = new Set<Promise<void>>();

/** Records `cleanup` so the next test cannot start before it settles, and returns it unchanged for callers that await. */
export function trackCleanup(cleanup: Promise<void>): Promise<void> {
	pendingCleanups.add(cleanup);
	cleanup.catch(() => {});
	return cleanup;
}

export async function joinPendingCleanups(): Promise<void> {
	const results = await Promise.allSettled([...pendingCleanups]);
	pendingCleanups.clear();
	const failure = results.find((result) => result.status === "rejected");
	if (failure !== undefined) throw failure.reason;
}
