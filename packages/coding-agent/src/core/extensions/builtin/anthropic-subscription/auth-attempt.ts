import type { AccountSlot } from "./accounts.ts";
import type { Options, SDKMessage, SdkQuery } from "./sdk-boundary.ts";
import type { AnthropicSubscriptionTokenInjection } from "./settings.ts";

export type AuthenticatedAttemptInput = {
	accountName: string;
	accounts: readonly AccountSlot[];
	authLane: AnthropicSubscriptionTokenInjection;
	options: Options;
};

export interface RetainableAttempt<TEvent> {
	messages: AsyncIterable<TEvent>;
	discard(): void;
}

export type AttemptFactoryInput = {
	prompt: Parameters<SdkQuery>[0]["prompt"];
	query: SdkQuery;
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
	if (input.createAttempt) return retainedAttemptMessages(await input.createAttempt(auth));
	const query = input.query({ prompt: input.prompt, options: auth.options });
	input.onQuery?.(query);
	return closingQueryMessages(query);
}
