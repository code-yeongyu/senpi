/** Process shutdown entry shared by EOF, signals and transport failures. */
export function createRpcShutdown(
	dispose: (signal?: NodeJS.Signals) => Promise<void>,
	exit: (code: number) => never,
): (exitCode?: number, signal?: NodeJS.Signals) => Promise<never> {
	let pending: Promise<never> | undefined;
	let code = 0;
	return (exitCode = 0, signal?: NodeJS.Signals): Promise<never> => {
		if (code === 0) code = exitCode;
		if (pending) return pending;
		pending = (async () => {
			await dispose(signal);
			return exit(code);
		})();
		return pending;
	};
}
