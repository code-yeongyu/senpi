// Shared fixture for the S27b offline-grant tests: a raw brain end that sends invokes and reads every frame back, and a
// hand executor for one authenticated peer whose scope, ledger and tool record what reached them.
import { realpathSync } from "node:fs";
import {
	createGrantVerifier,
	createRemoteExecutor,
	decodeRemoteMessage,
	encodeRemoteMessage,
	type GrantRow,
	type GrantSnapshot,
	type GrantVerifier,
	type HandLedger,
	HAND_CONTROL_LANE,
	type RemoteHandMessage,
	type WorkspaceRoot,
} from "@earendil-works/pi-agent-core";
import { openLink } from "./remote-hand-fixture.ts";

export const HAND = "device-hand";
export const BRAIN = "device-brain";

export const grant = (overrides: Partial<GrantRow> = {}): GrantRow => ({
	holder: BRAIN,
	target: HAND,
	workspace: "omo",
	capability: "execute",
	...overrides,
});

export const snapshotOf = (
	grants: readonly GrantRow[],
	expiresAt = Number.MAX_SAFE_INTEGER,
	rv = 1,
): GrantSnapshot => ({
	rv,
	expiresAt,
	grants,
});

export interface GrantHarnessOptions {
	readonly workspaces: readonly WorkspaceRoot[];
	readonly snapshot?: GrantSnapshot;
	readonly peer?: string;
	readonly now?: () => number;
	/** The tool's body; it runs until this settles or the call is aborted. */
	readonly body?: (signal: AbortSignal) => Promise<void>;
	/** Holds every scope open until it settles. */
	readonly scopeGate?: Promise<void>;
}

export function grantHarness(options: GrantHarnessOptions) {
	const { brain, hand } = openLink();
	const verifier: GrantVerifier = createGrantVerifier({
		self: HAND,
		workspaces: options.workspaces,
		canonicalize: (path) => realpathSync(path),
		...(options.now === undefined ? {} : { now: options.now }),
	});
	if (options.snapshot !== undefined) verifier.install(options.snapshot);
	const opened: string[] = [];
	const ran: string[] = [];
	const admitted: string[] = [];
	const aborted: string[] = [];
	const started: Array<() => void> = [];
	const opening: Array<() => void> = [];
	const ledger: HandLedger = {
		admit: async (invoke) => {
			admitted.push(invoke.executionId);
			return { kind: "run" };
		},
		settle: async (invoke, result) => ({ kind: "settled", executionId: invoke.executionId, result }),
		ack: async () => {},
		recover: async () => [],
	};
	const executor = createRemoteExecutor({
		transport: hand,
		authority: { kind: "peer", peer: options.peer ?? BRAIN, verifier },
		ledger,
		openScope: async (scope) => {
			opened.push(scope.root);
			for (const wake of opening.splice(0)) wake();
			await options.scopeGate;
			return {
				run: async (call) => {
					ran.push(call.toolCallId);
					for (const wake of started.splice(0)) wake();
					call.signal.addEventListener("abort", () => aborted.push(call.toolCallId), { once: true });
					await (options.body ?? (async () => {}))(call.signal);
					return { content: [{ type: "text", text: "ran" }], details: {} };
				},
				isSequential: () => false,
				dispose: async () => {},
			};
		},
		onFault: (error) => {
			throw error;
		},
	});

	const frames: RemoteHandMessage[] = [];
	const waiters: Array<() => void> = [];
	brain.onFrame((frame) => {
		if (frame.lane === HAND_CONTROL_LANE) return;
		frames.push(decodeRemoteMessage(frame.payload));
		for (const wake of waiters.splice(0)) wake();
	});
	const frameCount = (count: number): Promise<RemoteHandMessage[]> =>
		new Promise((resolve) => {
			const check = (): void => {
				if (frames.length >= count) resolve([...frames]);
				else waiters.push(check);
			};
			check();
		});
	let next = 0;
	const invoke = async (root: string, sessionRef?: string): Promise<string> => {
		const executionId = `exec-${next++}`;
		await executor.ready;
		await brain.send(
			"scope-a",
			encodeRemoteMessage({
				kind: "invoke",
				executionId,
				batchId: "batch",
				index: 0,
				scope: { id: "scope-a", root },
				toolCallId: executionId,
				name: "read",
				arguments: {},
				...(sessionRef === undefined ? {} : { sessionRef }),
			}),
		);
		return executionId;
	};
	const runStarted = (): Promise<void> => new Promise((resolve) => started.push(resolve));
	const scopeOpening = (): Promise<void> => new Promise((resolve) => opening.push(resolve));
	return { verifier, executor, opened, ran, admitted, aborted, frames, frameCount, invoke, runStarted, scopeOpening };
}

export const outcome = (message: RemoteHandMessage | undefined): string =>
	message?.kind === "refused" ? `refused:${message.reason}` : (message?.kind ?? "none");
