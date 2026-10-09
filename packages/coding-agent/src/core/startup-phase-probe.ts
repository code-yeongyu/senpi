// Throwaway diagnostic instrumentation; never part of the production fix.
export function startupPhase<T>(phase: string, run: () => Promise<T>): Promise<T>;
export function startupPhase<T>(phase: string, run: () => T): T;
export function startupPhase(phase: string, run: () => unknown): unknown {
	if (process.env.PI_TIMING !== "1") return run();
	const started = performance.now();
	const finish = () =>
		process.stderr.write(
			`DFA_STARTUP_PHASE ${JSON.stringify({ phase, pid: process.pid, started, ms: performance.now() - started })}\n`,
		);
	const result = run();
	if (result instanceof Promise) {
		return result.then((value) => {
			finish();
			return value;
		});
	}
	finish();
	return result;
}
