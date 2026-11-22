import { defaultModelPerProvider } from "../../../model-resolver.ts";
import { redactSecrets } from "../../../sensitive-output.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./account-management.ts";
import type { ClaudeCliAccountCheck } from "./accounts.ts";
import { queryWithAuthLane } from "./auth-lane.ts";
import { classifySdkError, errorText, sdkAssistantFailure, sdkResultFailure } from "./errors.ts";
import { refusalError } from "./refusal.ts";
import { getSdkBoundary, loadClaudeAgentSdk, type SdkQueryHandle } from "./sdk-boundary.ts";
import type { AnthropicSubscriptionProviderSettings } from "./settings.ts";

export type DefaultModelSelection = { readonly provider?: string; readonly model?: string };

const CONNECTION_TEST_PROMPT = "Reply with OK";
const CONNECTION_TEST_TIMEOUT_MS = 60_000;
/** auth.json keeps the redacted provider message for the UI; a proxy's HTML error page must not bloat it. */
export const STORED_CHECK_MESSAGE_MAX_CHARS = 2_000;

type CheckFailure = { readonly reason: string; readonly error: unknown; readonly providerStatus?: unknown };

function storedMessage(error: unknown): string {
	const message = redactSecrets(errorText(error));
	if (message.length <= STORED_CHECK_MESSAGE_MAX_CHARS) return message;
	let end = STORED_CHECK_MESSAGE_MAX_CHARS - 1;
	// Never end on the first half of a surrogate pair.
	const last = message.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return `${message.slice(0, end)}…`;
}

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
 * no persisted session. The outcome uses the turn classifiers and retains the provider status and redacted message.
 */
export async function runClaudeCliConnectionTest(input: ClaudeCliConnectionTestInput): Promise<ClaudeCliAccountCheck> {
	const now = input.now ?? Date.now;
	const deadline = AbortSignal.timeout(input.timeoutMs ?? CONNECTION_TEST_TIMEOUT_MS);
	const signal = input.signal === undefined ? deadline : AbortSignal.any([input.signal, deadline]);
	let handle: SdkQueryHandle | undefined;
	const closeOnAbort = () => handle?.close();
	signal.addEventListener("abort", closeOnAbort, { once: true });
	const finish = (failure?: CheckFailure): ClaudeCliAccountCheck => {
		if (failure === undefined) return { model: input.model, outcome: "ok", at: now() };
		const { reason, error } = failure;
		const status =
			failure.providerStatus ??
			(error !== null && typeof error === "object" && "status" in error ? error.status : undefined);
		return {
			model: input.model,
			outcome: "failed",
			reason,
			message: storedMessage(error),
			...(typeof status === "number" ? { status } : {}),
			at: now(),
		};
	};
	// The deadline and the caller's cancel win over whatever the SDK reports after close().
	const abortedCheck = (): ClaudeCliAccountCheck | undefined =>
		deadline.aborted
			? finish({ reason: "timeout", error: "Connection test timed out." })
			: input.signal?.aborted
				? finish({ reason: "cancelled", error: "Connection test was cancelled." })
				: undefined;
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
			if (failure)
				return (
					abortedCheck() ??
					finish({
						reason: classifySdkError(failure).kind,
						error: failure,
						providerStatus:
							message.type === "result" && "api_error_status" in message ? message.api_error_status : undefined,
					})
				);
			if (message.type === "result") return finish();
		}
		return (
			abortedCheck() ??
			finish({ reason: "no_result", error: "Claude Code ended the connection test without a result." })
		);
	} catch (error) {
		return abortedCheck() ?? finish({ reason: classifySdkError(error).kind, error });
	} finally {
		signal.removeEventListener("abort", closeOnAbort);
	}
}
