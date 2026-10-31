import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { CLAUDE_SDK_OAUTH_API_ID } from "../core/extensions/builtin/anthropic-subscription/api-id.ts";
import { requireAnthropicSubscriptionCwd } from "../core/extensions/builtin/anthropic-subscription/session-cwd.ts";
import { streamAnthropicSubscription } from "../core/extensions/builtin/anthropic-subscription/stream.ts";
import { failure, projectAssistant, projectEvent } from "./projection.ts";
import {
	type ProviderCallCommand,
	type ProviderCallOutput,
	providerCallCommandSchema,
	providerCallOutputSchema,
} from "./schema.ts";

export interface SubscriptionEgressScope {
	readonly threadId: string;
	readonly epoch: number;
	readonly cwd: string;
	readonly affinityId: string;
}
export interface SubscriptionEgressExecutor {
	/** Start resolves after terminal delivery; cancellation can be submitted concurrently. */
	handle(command: unknown): Promise<void>;
	/** Aborts all calls and waits for provider settlement and output delivery. */
	dispose(): Promise<void>;
}
type Start = Extract<ProviderCallCommand, { type: "provider.call.start" }>;
type Call = { controller: AbortController; done: Promise<void>; terminal: boolean };

/**
 * Experimental, authenticated-channel endpoint. The caller binds local attachment authority;
 * this module opens no listener and is never registered by the normal provider startup.
 */
export function createSubscriptionEgressExecutor(
	attachment: SubscriptionEgressScope,
	send: (message: ProviderCallOutput) => Promise<void>,
): SubscriptionEgressExecutor {
	const scope = { ...attachment, cwd: requireAnthropicSubscriptionCwd(attachment.cwd) };
	const enabled = process.env.SENPI_EXPERIMENTAL_SUBSCRIPTION_EGRESS === "1";
	const active = new Map<string, Call>();
	const seen = new Set<string>();
	let disposed = false;

	async function run(command: Start, call: Call): Promise<void> {
		const identity = { version: 1 as const, threadId: scope.threadId, epoch: scope.epoch, callId: command.callId };
		let seq = 0;
		let stream: AssistantMessageEventStream | undefined;
		const publish = async (record: ProviderCallOutput) => {
			await send(providerCallOutputSchema.parse(record));
		};
		try {
			const model = getModels("anthropic").find((entry) => entry.id === command.model);
			if (!model) {
				call.terminal = true;
				await publish({
					...identity,
					type: "provider.call.error",
					seq: seq++,
					code: "invalid_request",
					retryable: false,
					billing: "subscription",
				});
				return;
			}
			stream = streamAnthropicSubscription(
				{
					...model,
					provider: "anthropic-subscription",
					api: CLAUDE_SDK_OAUTH_API_ID,
					baseUrl: CLAUDE_SDK_OAUTH_API_ID,
				},
				command.context,
				{ ...command.options, cwd: scope.cwd, affinitySessionId: scope.affinityId, signal: call.controller.signal },
			);
			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") {
					call.terminal = true;
					const message = event.type === "done" ? event.message : event.error;
					if (event.type === "error" || call.controller.signal.aborted) {
						const reason = failure(
							message.errorMessage ?? "",
							call.controller.signal.aborted || (event.type === "error" && event.reason === "aborted"),
						);
						await publish({
							...identity,
							type: "provider.call.error",
							seq: seq++,
							...reason,
							message: projectAssistant(message, reason.code),
							billing: "subscription",
						});
					} else {
						await publish({
							...identity,
							type: "provider.call.end",
							seq: seq++,
							message: projectAssistant(message),
							billing: "subscription",
						});
					}
					return;
				}
				if (!call.controller.signal.aborted) {
					await publish({ ...identity, type: "provider.call.event", seq: seq++, event: projectEvent(event) });
				}
			}
			throw new Error("Subscription stream ended without a terminal event");
		} finally {
			// A rejected sink must stop provider work too. Wait for the adapter's actual terminal,
			// rather than treating abort() as a receipt that the SDK process has stopped.
			call.controller.abort();
			if (stream) await stream.result();
		}
	}

	return {
		async handle(input) {
			if (!enabled) throw new Error("Subscription egress is disabled");
			if (disposed) throw new Error("Subscription egress is disposed");
			const parsed = providerCallCommandSchema.safeParse(input);
			if (!parsed.success) throw new Error("Invalid subscription command");
			const command = parsed.data;
			if (command.threadId !== scope.threadId || command.epoch !== scope.epoch) {
				throw new Error("Subscription scope mismatch");
			}
			if (command.type === "provider.call.cancel") {
				const call = active.get(command.callId);
				if (call && !call.terminal) call.controller.abort();
				return;
			}
			if (seen.has(command.callId)) throw new Error("Subscription duplicate callId");
			seen.add(command.callId);
			const call: Call = { controller: new AbortController(), done: Promise.resolve(), terminal: false };
			active.set(command.callId, call);
			call.done = run(command, call).finally(() => active.delete(command.callId));
			await call.done;
		},
		async dispose() {
			disposed = true;
			for (const call of active.values()) if (!call.terminal) call.controller.abort();
			const results = await Promise.allSettled(Array.from(active.values(), (call) => call.done));
			const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (errors.length > 0) throw new AggregateError(errors, "Subscription egress delivery failed");
		},
	};
}
