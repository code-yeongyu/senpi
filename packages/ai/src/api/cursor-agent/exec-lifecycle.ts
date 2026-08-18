export type ExecHeartbeatOptions = {
	readonly intervalMs: number;
	readonly isClosed: () => boolean;
	readonly writeHeartbeat: (onComplete: (error?: Error | null) => void) => void;
};

/**
 * Arm one exec-scoped heartbeat at a time.
 *
 * The next timer starts only after the current write callback succeeds, so a
 * slow HTTP/2 write can never accumulate overlapping heartbeat frames.
 */
export function armExecHeartbeat(options: ExecHeartbeatOptions): () => void {
	let active = true;
	let timer: NodeJS.Timeout | undefined;

	const schedule = () => {
		if (!active || options.isClosed()) return;
		timer = setTimeout(() => {
			timer = undefined;
			if (!active || options.isClosed()) return;
			options.writeHeartbeat((error) => {
				if (error || !active || options.isClosed()) return;
				schedule();
			});
		}, options.intervalMs);
	};

	schedule();
	return () => {
		active = false;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};
}
