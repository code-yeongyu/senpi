import { type MountSnapshot, readMountTable } from "../../src/core/extensions/builtin/permission-system/mount-table.ts";
import type { ResolverTransport } from "../../src/core/extensions/builtin/permission-system/path-identity-host.ts";
import type {
	ResolverRequest,
	ResolverSnapshotMessage,
	ResolverWorkerMessage,
} from "../../src/core/extensions/builtin/permission-system/path-identity-protocol.ts";
import { createResolverService } from "../../src/core/extensions/builtin/permission-system/path-identity-worker.ts";

export interface FixtureTransportOptions {
	/** Requests for which the worker never answers (a wedge), by request. */
	readonly stall?: (request: ResolverRequest) => boolean;
	/** Answer delay in ms for matching requests (fake timers advance it). */
	readonly delayMs?: (request: ResolverRequest) => number;
	/** Whether `terminate()` resolves; a never-resolving terminate models a thread stuck in a syscall. */
	readonly terminateResolves?: boolean;
	/** An error the worker reports before it ever publishes a snapshot: a startup failure such as a missing module. */
	readonly startupError?: string;
	/** The mount snapshot the worker publishes; defaults to the live table. */
	readonly snapshot?: MountSnapshot;
	readonly firmlinks?: readonly string[];
}

export interface FixtureTransport extends ResolverTransport {
	readonly posted: ResolverRequest[];
	readonly terminated: { count: number; resolve: () => void };
	readonly stalled: ResolverRequest[];
}

/** An in-thread stand-in for the resolver worker with the same filesystem work and controllable stalls. */
export function fixtureTransport(options: FixtureTransportOptions = {}): FixtureTransport {
	const service = createResolverService(() => options.snapshot ?? readMountTable());
	const handlers: ((message: ResolverWorkerMessage) => void)[] = [];
	const errorHandlers: ((error: Error) => void)[] = [];
	const posted: ResolverRequest[] = [];
	const stalled: ResolverRequest[] = [];
	let terminateSettle: (() => void) | undefined;
	const terminated = { count: 0, resolve: () => terminateSettle?.() };
	let alive = true;
	const deliver = (message: ResolverWorkerMessage) => {
		if (!alive) return;
		for (const handler of handlers) handler(message);
	};
	const snapshotMessage = (): ResolverSnapshotMessage => {
		const live = service.snapshot();
		return {
			type: "snapshot",
			snapshot: options.snapshot ?? live.snapshot,
			firmlinks: options.firmlinks ?? live.firmlinks,
		};
	};
	return {
		posted,
		stalled,
		terminated,
		post(request) {
			posted.push(request);
			if (request.kind === "refresh") {
				queueMicrotask(() => deliver(snapshotMessage()));
				return;
			}
			if (options.stall?.(request)) {
				stalled.push(request);
				return;
			}
			const delay = options.delayMs?.(request) ?? 0;
			const reply = () => deliver(service.serve(request));
			if (delay > 0) setTimeout(reply, delay);
			else queueMicrotask(reply);
		},
		onMessage(handler) {
			handlers.push(handler);
			if (options.startupError !== undefined) return;
			deliver(snapshotMessage());
		},
		onError(handler) {
			errorHandlers.push(handler);
			if (options.startupError === undefined) return;
			const error = Object.assign(new Error(options.startupError), { code: options.startupError });
			queueMicrotask(() => {
				for (const errorHandler of errorHandlers) errorHandler(error);
			});
		},
		onExit() {},
		terminate() {
			terminated.count += 1;
			alive = false;
			if (options.terminateResolves === false) {
				return new Promise<void>((resolve) => {
					terminateSettle = resolve;
				});
			}
			return Promise.resolve();
		},
	};
}
