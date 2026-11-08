/**
 * CK22 reference hosted session driver (custody design 15.1, 15.2). It runs the real `AgentSession` / `Agent` /
 * agent loop with the faux provider and holds the hosted invariants CK1s asserts against:
 * - the commit latches and bumps the instance generation synchronously, before its promise rejects;
 * - every provider call needs an admission for the current generation (refused otherwise, zero dials);
 * - durable history rows come only from admitted input and committed steps, never from the session's own writes;
 * - events are stamped with their instance generation and only the current generation is forwarded;
 * - a rejected commit rebuilds a fresh instance from the durable rows.
 * The commit hook is installed on the test agent instance (`createLoopConfig`) until the CK1p seam exists (C.P3).
 */
import {
	HOSTED_REBUILD_DEADLINE_MS,
	type AgentLoopConfig,
	type AgentMessage,
	isStepCommitError,
	type StepCommit,
	StepCommitError,
	type StepCommitFailure,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { FauxCallLogEntry } from "@earendil-works/pi-ai/compat";
import type { AgentSession, AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { createHarness, type Harness, type HarnessOptions } from "../../suite/harness.ts";

export type HistoryRow =
	| { readonly kind: "input"; readonly message: AgentMessage }
	| { readonly kind: "step"; readonly stepId: string; readonly message: AgentMessage };

export interface LatchRecord {
	readonly stepId: string;
	readonly code: StepCommitFailure;
	readonly generationAfter: number;
	readonly forwardedBefore: number;
}

export interface ForwardedEvent {
	readonly generation: number;
	readonly event: AgentSessionEvent;
}

export interface InboxEntry {
	readonly text: string;
	consumedBy?: number;
}

export interface DriverCounters {
	readonly admissions: number;
	readonly refusals: number;
	readonly providerCalls: number;
	readonly events: number;
	readonly drainedBy: readonly number[];
	readonly adapterAppendAttempts: number;
	readonly rebuildDeadlineMisses: number;
}

export interface FakeClock {
	now(): number;
	advance(ms: number): void;
	sleep(ms: number): Promise<void>;
}

function createFakeClock(): FakeClock {
	let now = 0;
	const sleepers: Array<{ readonly until: number; readonly wake: () => void }> = [];
	return {
		now: () => now,
		advance(ms) {
			now += ms;
			for (const sleeper of sleepers.filter((candidate) => candidate.until <= now)) {
				sleepers.splice(sleepers.indexOf(sleeper), 1);
				sleeper.wake();
			}
		},
		sleep(ms) {
			const { promise, resolve } = Promise.withResolvers<void>();
			sleepers.push({ until: now + ms, wake: resolve });
			return promise;
		},
	};
}

export interface ReferenceDriver {
	readonly session: AgentSession;
	readonly generation: number;
	readonly latched: boolean;
	readonly clock: FakeClock;
	readonly rows: readonly HistoryRow[];
	readonly inbox: readonly InboxEntry[];
	readonly forwarded: readonly ForwardedEvent[];
	readonly latchHistory: readonly LatchRecord[];
	readonly counters: DriverCounters;
	readonly rebuilds: number;
	readonly inject: {
		nextCommit(kind: "reject", code?: StepCommitFailure): void;
		nextCommit(kind: "already-committed", committedByAnother: AgentMessage): void;
		nextCommit(kind: "ambiguous-landed" | "ambiguous-lost"): void;
		advanceFenceBeforeNextCommit(): void;
		epochUnverifiedUntilConfirmed(): void;
		cancelNextStep(): void;
		slowRebuildStoreRead(ms: number): void;
	};
	rebuildStoreReadStarted(): Promise<void>;
	deliverLateLanding(): "refused" | "landed" | "none";
	epochWaitReached(): Promise<void>;
	confirmEpoch(): void;
	setResponses: Harness["setResponses"];
	appendResponses: Harness["appendResponses"];
	prompt(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	settle(): Promise<void>;
	callLog(): FauxCallLogEntry[];
	cleanup(): void;
}

const userText = (message: AgentMessage): string | undefined => {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
};

export function projectHistoryRows(rows: readonly HistoryRow[]): AgentMessage[] {
	return rows.map((row) => row.message);
}

interface LoopConfigOwner {
	createLoopConfig(...args: unknown[]): AgentLoopConfig;
}

interface AdapterMirror {
	_appendEntry(...args: unknown[]): unknown;
}

interface Fence {
	readonly epoch: number;
	readonly admissionSeq: number;
	readonly generation: number;
}

type PlannedFault =
	| { readonly kind: "reject"; readonly code: StepCommitFailure }
	| { readonly kind: "already-committed"; readonly committedByAnother: AgentMessage }
	| { readonly kind: "ambiguous-landed" }
	| { readonly kind: "ambiguous-lost" };

const sameFence = (a: Fence, b: Fence): boolean =>
	a.epoch === b.epoch && a.admissionSeq === b.admissionSeq && a.generation === b.generation;

export async function createReferenceDriver(options: HarnessOptions = {}): Promise<ReferenceDriver> {
	const rows: HistoryRow[] = [];
	const forwarded: ForwardedEvent[] = [];
	const inbox: InboxEntry[] = [];
	const drainedBy: number[] = [];
	const rowMessages = new WeakSet<object>();
	const latchHistory: LatchRecord[] = [];
	const plannedFaults: PlannedFault[] = [];
	let fence: Fence = { epoch: 1, admissionSeq: 0, generation: 1 };
	let advanceFenceBeforeNextCommit = false;
	let lateLanding: { readonly stepId: string; readonly fence: Fence; readonly message: AgentMessage } | undefined;
	let epochWait:
		| { readonly reached: PromiseWithResolvers<void>; readonly confirmed: PromiseWithResolvers<void> }
		| undefined;
	let cancelNextStep = false;
	const clock = createFakeClock();
	let latchedAt: number | undefined;
	let rebuildDeadlineMisses = 0;
	let slowRead: { readonly ms: number; readonly started: PromiseWithResolvers<void> } | undefined;
	const cancelledSteps = new Set<string>();
	let cancelledAbort: { readonly stepId: string; readonly message: AgentMessage } | undefined;
	const instances: Harness[] = [];
	let generation = 1;
	let admissions = 0;
	let refusals = 0;
	let rebuilds = 0;
	let adapterAppendAttempts = 0;

	const first = await createHarness(options);
	let current = first;

	function install(harness: Harness, instanceGeneration: number): void {
		instances.push(harness);
		// The in-memory SessionManager is the HostedSessionAdapter's read mirror (15.2): every session write lands
		// there and is counted; durable rows come only from commits and inbox consumes.
		const mirror = harness.sessionManager as unknown as AdapterMirror;
		const appendToMirror = mirror._appendEntry.bind(harness.sessionManager);
		mirror._appendEntry = (...args: unknown[]) => {
			adapterAppendAttempts += 1;
			return appendToMirror(...args);
		};
		const owner = harness.agent as unknown as LoopConfigOwner;
		const createLoopConfig = owner.createLoopConfig.bind(harness.agent);
		let admitted: { readonly stepId: string; readonly fence: Fence } | undefined;

		const latch = (stepId: string, code: StepCommitFailure): never => {
			// Latch before the promise rejects: anything the session runs on its way out sees the new generation.
			generation += 1;
			latchedAt = clock.now();
			latchHistory.push({ stepId, code, generationAfter: generation, forwardedBefore: forwarded.length });
			throw new StepCommitError(stepId, code);
		};
		const writeStep = (stepId: string, step: StepCommit): void => {
			rows.push({ kind: "step", stepId, message: step.message });
			for (const result of step.providerToolResults) rows.push({ kind: "step", stepId, message: result });
		};
		const hasRow = (stepId: string): boolean => rows.some((row) => row.kind === "step" && row.stepId === stepId);

		const commitStep = async (step: StepCommit): Promise<void> => {
			if (instanceGeneration !== generation || admitted === undefined) {
				refusals += 1;
				throw new StepCommitError(`stale-${instanceGeneration}`, "generation");
			}
			const { stepId } = admitted;
			if (epochWait !== undefined) {
				// epoch_unverified waits for a fresh epoch and re-checks; it never latches (15.4, C.P4 reading).
				const wait = epochWait;
				wait.reached.resolve();
				await wait.confirmed.promise;
				epochWait = undefined;
			}
			if (cancelledSteps.has(stepId)) {
				cancelledAbort = {
					stepId,
					message:
						step.message.role === "assistant"
							? { ...step.message, content: [], stopReason: "aborted" }
							: step.message,
				};
			}
			if (advanceFenceBeforeNextCommit) {
				advanceFenceBeforeNextCommit = false;
				fence = { ...fence, admissionSeq: fence.admissionSeq + 1 };
			}
			if (!sameFence(admitted.fence, fence)) latch(stepId, "fenced");
			const fault = plannedFaults.shift();
			if (fault?.kind === "reject") latch(stepId, fault.code);
			if (fault?.kind === "already-committed") {
				rows.push({ kind: "step", stepId, message: fault.committedByAnother });
			}
			if (fault?.kind === "ambiguous-lost") {
				// The write did not apply and its reply was lost: a negative read-back advances the fence, so the first
				// write landing late is refused.
				lateLanding = { stepId, fence: admitted.fence, message: step.message };
				fence = { ...fence, admissionSeq: fence.admissionSeq + 1 };
				latch(stepId, "ambiguous_unresolved");
			}
			// The conditional write: a row for this step from any other admission is `already_committed`.
			if (hasRow(stepId)) latch(stepId, "already_committed");
			writeStep(stepId, step);
			// `ambiguous-landed` applied the write and lost the reply; the read-back finds the row, so it is committed.
		};
		owner.createLoopConfig = (...args: unknown[]) => ({ ...createLoopConfig(...args), commitStep });

		const dial: StreamFn = harness.agent.streamFunction;
		harness.agent.streamFunction = (model, context, streamOptions) => {
			if (instanceGeneration !== generation) {
				refusals += 1;
				throw new StepCommitError(`stale-${instanceGeneration}`, "generation");
			}
			admissions += 1;
			fence = { epoch: fence.epoch, admissionSeq: fence.admissionSeq + 1, generation };
			admitted = { stepId: `step-${fence.admissionSeq}`, fence };
			if (cancelNextStep) {
				cancelNextStep = false;
				cancelledSteps.add(admitted.stepId);
			}
			return dial(model, context, streamOptions);
		};

		// The always-on inbox owns queued input: a drain is consumed per message by the current generation only,
		// and a refused consume leaves the message in the inbox for the rebuilt instance.
		harness.agent.queuedInputPort = {
			claim: async (_queue, drain) => drain(),
			release: async (_queue, _messages, giveBack) => {
				giveBack.restore();
			},
			commitConsumption: async (_queue, messages) => {
				if (instanceGeneration !== generation) {
					refusals += 1;
					throw new StepCommitError(`stale-${instanceGeneration}`, "generation");
				}
				for (const message of messages) {
					const text = userText(message);
					const entry = inbox.find((candidate) => candidate.consumedBy === undefined && candidate.text === text);
					if (entry) entry.consumedBy = instanceGeneration;
					rows.push({ kind: "input", message });
					rowMessages.add(message);
				}
				drainedBy.push(instanceGeneration);
			},
		};

		harness.session.subscribe((event) => {
			if (instanceGeneration !== generation) return;
			forwarded.push({ generation: instanceGeneration, event });
			if (event.type === "message_end" && event.message.role === "user" && !rowMessages.has(event.message)) {
				rows.push({ kind: "input", message: event.message });
				rowMessages.add(event.message);
			}
		});
	}

	// The store reads behind a rebuild must finish within HOSTED_REBUILD_DEADLINE_MS of the latch (2.7(4)). A miss
	// keeps the session latched and retries the rebuild; it never waits on the old instance.
	async function readDurableHistory(): Promise<void> {
		for (;;) {
			const read = slowRead;
			slowRead = undefined;
			if (read !== undefined) {
				const done = clock.sleep(read.ms);
				read.started.resolve();
				await done;
			}
			const since = latchedAt ?? clock.now();
			if (clock.now() - since <= HOSTED_REBUILD_DEADLINE_MS) return;
			rebuildDeadlineMisses += 1;
			latchedAt = clock.now();
		}
	}

	async function rebuild(): Promise<void> {
		await readDurableHistory();
		// A cancelled step is never redialed: its synthesized aborted message is committed once (W14).
		const aborted = cancelledAbort;
		cancelledAbort = undefined;
		if (aborted !== undefined && !rows.some((row) => row.kind === "step" && row.stepId === aborted.stepId)) {
			rows.push({ kind: "step", stepId: aborted.stepId, message: aborted.message });
		}
		const next = await createHarness({ ...options, siblingOf: first });
		const history = projectHistoryRows(rows);
		for (const message of history)
			next.sessionManager.appendMessage(message as Parameters<typeof next.sessionManager.appendMessage>[0]);
		next.agent.state.messages = history;
		install(next, generation);
		current = next;
		rebuilds += 1;
		latchedAt = undefined;
		const pending = inbox.filter((entry) => entry.consumedBy === undefined);
		for (const entry of pending) await next.session.followUp(entry.text);
		// Re-admission: history ending in input the model has not answered (no committed row) dials again.
		if (pending.length > 0 || rows.at(-1)?.kind === "input") {
			await next.agent.continue().catch(() => undefined);
		}
	}

	install(first, generation);

	return {
		get session() {
			return current.session;
		},
		get generation() {
			return generation;
		},
		get latched() {
			return latchedAt !== undefined;
		},
		clock,
		rows,
		inbox,
		forwarded,
		latchHistory,
		get counters(): DriverCounters {
			return {
				admissions,
				refusals,
				providerCalls: first.faux.getCallLog().length,
				events: forwarded.length,
				drainedBy,
				adapterAppendAttempts,
				rebuildDeadlineMisses,
			};
		},
		get rebuilds() {
			return rebuilds;
		},
		inject: {
			nextCommit(kind: PlannedFault["kind"], arg?: StepCommitFailure | AgentMessage) {
				if (kind === "reject") {
					plannedFaults.push({ kind, code: typeof arg === "string" ? arg : "storage_unavailable" });
				} else if (kind === "already-committed") {
					if (arg === undefined || typeof arg === "string")
						throw new Error("already-committed needs the other row");
					plannedFaults.push({ kind, committedByAnother: arg });
				} else {
					plannedFaults.push({ kind });
				}
			},
			advanceFenceBeforeNextCommit() {
				advanceFenceBeforeNextCommit = true;
			},
			epochUnverifiedUntilConfirmed() {
				epochWait = { reached: Promise.withResolvers<void>(), confirmed: Promise.withResolvers<void>() };
			},
			cancelNextStep() {
				cancelNextStep = true;
			},
			slowRebuildStoreRead(ms: number) {
				slowRead = { ms, started: Promise.withResolvers<void>() };
			},
		},
		rebuildStoreReadStarted() {
			if (slowRead === undefined) throw new Error("no slow rebuild read is armed");
			return slowRead.started.promise;
		},
		epochWaitReached() {
			if (epochWait === undefined) throw new Error("no epoch wait is armed");
			return epochWait.reached.promise;
		},
		confirmEpoch() {
			epochWait?.confirmed.resolve();
		},
		deliverLateLanding() {
			const landing = lateLanding;
			if (landing === undefined) return "none";
			lateLanding = undefined;
			if (!sameFence(landing.fence, fence)) {
				refusals += 1;
				return "refused";
			}
			rows.push({ kind: "step", stepId: landing.stepId, message: landing.message });
			return "landed";
		},
		setResponses: first.setResponses,
		appendResponses: first.appendResponses,
		async prompt(text: string) {
			const latchesBefore = latchHistory.length;
			try {
				await current.session.prompt(text);
			} catch (error) {
				if (!isStepCommitError(error)) throw error;
			}
			// Under decision C the old instance synthesizes its failure and `prompt` may resolve, so the rebuild keys on
			// the latch, not on the rejection.
			if (latchHistory.length > latchesBefore) await rebuild();
		},
		async followUp(text: string) {
			inbox.push({ text });
			await current.session.followUp(text);
		},
		async settle() {
			await current.session.waitForIdle();
		},
		callLog() {
			return first.faux.getCallLog();
		},
		cleanup() {
			for (const instance of instances.reverse()) instance.cleanup();
		},
	};
}
