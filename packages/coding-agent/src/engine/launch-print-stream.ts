import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * One event of a print run. `event`: a JSON record the engine printed (json mode). `output`: printed text (text
 * mode, or a json-mode line that is not a record). The stream ends with exactly one terminal event.
 */
export type LaunchPrintEvent =
	| { readonly type: "event"; readonly event: unknown }
	| { readonly type: "output"; readonly text: string }
	| { readonly type: "exit"; readonly exit_code: number | null; readonly session?: string }
	| { readonly type: "cancelled" };

export interface LaunchPrintRun {
	readonly pid: number | undefined;
	readonly events: AsyncIterable<LaunchPrintEvent>;
	/** Ends the run; the stream then ends with `cancelled`. */
	stop(): void;
}

function sessionHeaderId(record: unknown): string | undefined {
	if (typeof record !== "object" || record === null) return undefined;
	if (Reflect.get(record, "type") !== "session") return undefined;
	const id: unknown = Reflect.get(record, "id");
	return typeof id === "string" ? id : undefined;
}

function parseRecord(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

/**
 * The run as a stream. `named` is the session the caller fixed; otherwise a json run's session header names it,
 * and an ephemeral run answers none.
 */
export function printRun(
	child: ChildProcess,
	exited: Promise<{ readonly exit_code: number | null }>,
	options: { readonly json: boolean; readonly named?: string; readonly ephemeral: boolean },
): LaunchPrintRun {
	const queue: LaunchPrintEvent[] = [];
	const waiters: Array<() => void> = [];
	let ended = false;
	let cancelled = false;
	let session = options.named;
	const push = (event: LaunchPrintEvent) => {
		queue.push(event);
		waiters.splice(0).forEach((wake) => wake());
	};
	const stdout = child.stdout;
	const lines: Promise<void> =
		stdout === null
			? Promise.resolve()
			: options.json
				? (async () => {
						for await (const line of createInterface({ input: stdout, crlfDelay: Number.POSITIVE_INFINITY })) {
							const record = parseRecord(line);
							if (record === undefined) push({ type: "output", text: line });
							else {
								session ??= options.ephemeral ? undefined : sessionHeaderId(record);
								push({ type: "event", event: record });
							}
						}
					})()
				: (async () => {
						for await (const chunk of stdout) push({ type: "output", text: String(chunk) });
					})();
	void Promise.all([lines.catch(() => undefined), exited]).then(([, { exit_code }]) => {
		push(
			cancelled
				? { type: "cancelled" }
				: { type: "exit", exit_code, ...(session === undefined || options.ephemeral ? {} : { session }) },
		);
		ended = true;
	});
	async function* events(): AsyncGenerator<LaunchPrintEvent> {
		for (;;) {
			const next = queue.shift();
			if (next !== undefined) {
				yield next;
				if (next.type === "exit" || next.type === "cancelled") return;
				continue;
			}
			if (ended) return;
			await new Promise<void>((wake) => waiters.push(wake));
		}
	}
	return {
		pid: child.pid,
		events: events(),
		stop() {
			cancelled = true;
			child.kill("SIGTERM");
		},
	};
}
