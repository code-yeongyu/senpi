import { subscriptionLimits } from "../../../subscription-limits/limit-store.ts";
import { claudeWindowsFromSdkEvent } from "../../../subscription-limits/limit-windows.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./account-management.ts";
import { attemptAccountContext, logAttemptAccount, rememberAccountContext } from "./account-context.ts";
import type { AccountSlot } from "./accounts.ts";
import type { PinSource } from "./affinity.ts";
import type { Options, SDKMessage, SdkQuery } from "./sdk-boundary.ts";
import type { AnthropicSubscriptionTokenInjection } from "./settings.ts";

export type AuthenticatedAttemptInput = {
	accountName: string;
	accounts: readonly AccountSlot[];
	authLane: AnthropicSubscriptionTokenInjection;
	pinSource?: PinSource;
	options: Options;
	/**
	 * Digest of the OAuth access token this attempt authenticates with. A
	 * resident session spawned with a different token must not serve the turn:
	 * a refresh revokes the previous access token, so that subprocess would
	 * answer 401 "token has been revoked".
	 */
	credentialDigest?: string;
};

export interface RetainableAttempt<TEvent> {
	messages: AsyncIterable<TEvent>;
	discard(): void;
}

export type AttemptFactoryInput = {
	prompt: Parameters<SdkQuery>[0]["prompt"];
	query: SdkQuery;
	sessionId?: string;
	onQuery?: (query: ReturnType<SdkQuery>) => void;
	createAttempt?: (
		input: AuthenticatedAttemptInput,
	) => RetainableAttempt<SDKMessage> | Promise<RetainableAttempt<SDKMessage>>;
};

/** Discards an attempt unless its event stream is consumed to successful completion. */
async function* retainedAttemptMessages<TEvent>(attempt: RetainableAttempt<TEvent>): AsyncGenerator<TEvent> {
	let retained = false;
	try {
		for await (const event of attempt.messages) yield event;
		retained = true;
	} finally {
		if (!retained) attempt.discard();
	}
}

async function* closingQueryMessages(query: ReturnType<SdkQuery>): AsyncGenerator<SDKMessage> {
	try {
		for await (const message of query) yield message;
	} finally {
		query.close();
	}
}

export async function createAttemptMessages(
	input: AttemptFactoryInput,
	auth: AuthenticatedAttemptInput,
): Promise<AsyncIterable<SDKMessage>> {
	const account = attemptAccountContext(auth);
	logAttemptAccount(auth, input.sessionId);
	// Claude Code loads auto memory independently of settingSources. Keep its private
	// notes out of every subscription session, after all auth and caller overrides.
	auth.options.env = { ...auth.options.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
	if (typeof auth.options.settings !== "string")
		auth.options.settings = { ...auth.options.settings, autoMemoryEnabled: false };
	try {
		if (input.createAttempt)
			return recordingLimitWindows(retainedAttemptMessages(await input.createAttempt(auth)), auth);
		const query = input.query({ prompt: input.prompt, options: auth.options });
		input.onQuery?.(query);
		return recordingLimitWindows(closingQueryMessages(query), auth);
	} catch (error) {
		rememberAccountContext(error, account);
		throw error;
	}
}

/** The SDK reports the account's limit windows as `rate_limit_event` messages: kept for that account (senpi#3370). */
async function* recordingLimitWindows(
	messages: AsyncIterable<SDKMessage>,
	auth: AuthenticatedAttemptInput,
): AsyncGenerator<SDKMessage> {
	const account = attemptAccountContext(auth);
	try {
		for await (const message of messages) {
			rememberAccountContext(message, account);
			if (message.type === "rate_limit_event")
				subscriptionLimits.record(
					ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
					auth.accountName,
					claudeWindowsFromSdkEvent(message),
				);
			yield message;
		}
	} catch (error) {
		rememberAccountContext(error, account);
		throw error;
	}
}
