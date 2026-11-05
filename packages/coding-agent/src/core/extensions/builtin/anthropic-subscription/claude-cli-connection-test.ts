import { defaultModelPerProvider } from "../../../model-resolver.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./account-management.ts";
import type { ClaudeCliAccountCheck } from "./accounts.ts";
import { queryWithAuthLane } from "./auth-lane.ts";
import { classifySdkError, sdkAssistantFailure, sdkResultFailure } from "./errors.ts";
import { refusalError } from "./refusal.ts";
import { getSdkBoundary, loadClaudeAgentSdk, type SdkQueryHandle } from "./sdk-boundary.ts";
import type { AnthropicSubscriptionProviderSettings } from "./settings.ts";

export type DefaultModelSelection = { readonly provider?: string; readonly model?: string };

const CONNECTION_TEST_PROMPT = "Reply with OK";
const CONNECTION_TEST_TIMEOUT_MS = 60_000;

/**
 * The model the sign-in connection test runs on: the default model when the default provider is this one, else the
 * provider's own default (`defaultModelPerProvider`), so the test exercises the model the user's turns will use.
 */
export function connectionTestModel(defaults: DefaultModelSelection | undefined): string {
	if (defaults?.provider === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID && defaults.model) return defaults.model;
	const fallback = defaultModelPerProvider[ANTHROPIC_SUBSCRIPTION_PROVIDER_ID];
	if (fallback === undefined) throw new Error("No default model for anthropic-subscription");
	return fallback;
}

export type ClaudeCliConnectionTestInput = {
	readonly name: string;
	readonly model: string;
	readonly executable: string;
	readonly cwd: string;
	readonly providerSettings: AnthropicSubscriptionProviderSettings;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly now?: () => number;
};

/**
 * One "Reply with OK" turn on the named account, pinned with account fallback off, no tools, no setting sources and
 * no persisted session. The outcome is classified with the turn classifiers; only the kind is kept, never error text.
 */
export async function runClaudeCliConnectionTest(input: ClaudeCliConnectionTestInput): Promise<ClaudeCliAccountCheck> {
	const now = input.now ?? Date.now;
	const deadline = AbortSignal.timeout(input.timeoutMs ?? CONNECTION_TEST_TIMEOUT_MS);
	const signal = input.signal === undefined ? deadline : AbortSignal.any([input.signal, deadline]);
	let handle: SdkQueryHandle | undefined;
	const closeOnAbort = () => handle?.close();
	signal.addEventListener("abort", closeOnAbort, { once: true });
	const finish = (outcome: "ok" | "failed", reason?: string): ClaudeCliAccountCheck => ({
		model: input.model,
		outcome,
		...(reason === undefined ? {} : { reason }),
		at: now(),
	});
	try {
		await loadClaudeAgentSdk();
		const messages = queryWithAuthLane({
			prompt: CONNECTION_TEST_PROMPT,
			query: getSdkBoundary().query,
			providerSettings: { ...input.providerSettings, tokenInjection: "oauth-slots", accountFallback: false },
			signal,
			pinnedAccount: input.name,
			probe: true,
			model: input.model,
			onQuery: (query) => {
				handle = query;
				if (signal.aborted) query.close();
			},
			buildOptions: () => ({
				cwd: input.cwd,
				model: input.model,
				tools: [],
				maxTurns: 1,
				settingSources: [],
				persistSession: false,
				permissionMode: "dontAsk",
				pathToClaudeCodeExecutable: input.executable,
			}),
		});
		for await (const message of messages) {
			const failure =
				refusalError(message) ??
				(message.type === "assistant"
					? sdkAssistantFailure(message)
					: message.type === "result"
						? sdkResultFailure(message)
						: undefined);
			if (failure) throw failure;
			if (message.type === "result") return finish("ok");
		}
		return finish("failed", signal.aborted ? (deadline.aborted ? "timeout" : "cancelled") : "no_result");
	} catch (error) {
		if (deadline.aborted) return finish("failed", "timeout");
		if (input.signal?.aborted) return finish("failed", "cancelled");
		return finish("failed", classifySdkError(error).kind);
	} finally {
		signal.removeEventListener("abort", closeOnAbort);
	}
}
