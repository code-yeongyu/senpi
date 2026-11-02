import { join } from "node:path";
import type {
	RegisterControlEndpointOptions,
	SessionControlDrain,
	SessionControlWakeEvent,
} from "../../src/core/extensions/types.ts";
import type { TuiControlSurface } from "../../src/modes/interactive/session-control-commands.ts";
import {
	type ActiveControlEndpoint,
	registerSessionControlEndpoint,
} from "../../src/modes/interactive/session-control-endpoint.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

export interface EndpointFixture {
	readonly harness: Harness;
	readonly agentDir: string;
	readonly inboxDir: string;
	readonly endpoint: ActiveControlEndpoint;
	readonly socket: string;
	readonly notices: string[];
	readonly wakes: SessionControlWakeEvent[];
	nextWake(reason: SessionControlWakeEvent["reason"], seenAtDrain?: () => boolean): Promise<SessionControlWakeEvent>;
	setDraft(hold: "draft" | undefined): void;
}

export async function startEndpoint(
	options: {
		readonly drain?: SessionControlDrain;
		readonly isSessionReferenced?: RegisterControlEndpointOptions["isSessionReferenced"];
		readonly harness?: Harness;
		readonly agentDir?: string;
		readonly questions?: Pick<TuiControlSurface, "pendingQuestionIds" | "pendingQuestion" | "answerQuestion">;
	} = {},
): Promise<EndpointFixture> {
	const harness = options.harness ?? (await createHarness({ persistSession: true }));
	const agentDir = options.agentDir ?? join(harness.tempDir, "agent");
	const inboxDir = join(harness.tempDir, "inbox");
	const notices: string[] = [];
	const wakes: SessionControlWakeEvent[] = [];
	const waiters: Array<{
		reason: SessionControlWakeEvent["reason"];
		seenAtDrain: () => boolean;
		resolve: (event: SessionControlWakeEvent) => void;
	}> = [];
	let draft: "draft" | undefined;
	const surface: TuiControlSurface = {
		draftHold: () => draft,
		blockingQuestion: () => false,
		pendingQuestionIds: options.questions?.pendingQuestionIds ?? (() => []),
		pendingQuestion: options.questions?.pendingQuestion ?? (() => undefined),
		answerQuestion: options.questions?.answerQuestion ?? (() => false),
		notice: (line) => notices.push(line),
		selectModel: (model) => harness.session.setModel(model),
		selectThinkingLevel: (level, remember) =>
			remember ? harness.session.setThinkingLevel(level) : harness.session.setSessionThinkingLevel(level),
		interruptTurn: () => harness.session.abort(),
	};
	const drain: SessionControlDrain = async (event) => {
		wakes.push(event);
		for (const waiter of waiters.splice(0)) {
			if (event.reasons.includes(waiter.reason) && waiter.seenAtDrain()) waiter.resolve(event);
			else waiters.push(waiter);
		}
		return options.drain?.(event);
	};
	const outcome = await registerSessionControlEndpoint(
		{ session: harness.session, agentDir, surface, editorRevision: () => 0 },
		{ inboxDir, drain, ...(options.isSessionReferenced ? { isSessionReferenced: options.isSessionReferenced } : {}) },
	);
	if (!("endpoint" in outcome))
		throw new Error(`registration failed: ${JSON.stringify(outcome.registration)} ${notices}`);
	return {
		harness,
		agentDir,
		inboxDir,
		endpoint: outcome.endpoint,
		socket: outcome.endpoint.socket,
		notices,
		wakes,
		nextWake: (reason, seenAtDrain = () => true) =>
			new Promise((resolve) => waiters.push({ reason, seenAtDrain, resolve })),
		setDraft: (hold) => {
			draft = hold;
		},
	};
}
