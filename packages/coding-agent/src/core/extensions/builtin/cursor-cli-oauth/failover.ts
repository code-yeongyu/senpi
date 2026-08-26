import type { CredentialStore } from "@earendil-works/pi-ai";
import { type CursorCliAccountSlot, type CursorCliOauthCredential, listAccounts } from "./accounts.ts";
import { type CursorAffinityOptions, selectAccount } from "./affinity.ts";
import {
	type CursorCliErrorClassification,
	type CursorCliErrorInput,
	classifyCursorCliError,
	DEFAULT_RATE_LIMIT_BLOCK_MS,
	MAX_RATE_LIMIT_BLOCK_MS,
} from "./errors.ts";

export type CursorCliFailoverNotice = {
	type: "cursor_account_changed";
	message: string;
	fromAccount: string;
	toAccount: string;
	freshChat: true;
	priorContextCarriedOver: false;
};

export type CursorCliAttemptOptions = {
	/** Cross-account Cursor chats cannot be resumed because each account has its own HOME. */
	freshChat: boolean;
};

export type CursorCliFailoverOptions<TEvent> = {
	store: CredentialStore;
	providerId: string;
	affinity?: CursorAffinityOptions;
	runAttempt: (
		account: CursorCliAccountSlot,
		options: CursorCliAttemptOptions,
	) => AsyncIterable<TEvent> | Promise<AsyncIterable<TEvent>>;
	now?: () => number;
	classify?: (input: CursorCliErrorInput) => CursorCliErrorClassification;
	errorFromEvent?: (event: TEvent) => CursorCliErrorInput | undefined;
	isVisibleAssistantDelta?: (event: TEvent) => boolean;
};

export class CursorCliFailoverError extends Error {
	readonly classification: CursorCliErrorClassification;
	readonly original: unknown;
	readonly visibleAssistantDeltaEmitted: boolean;

	constructor(classification: CursorCliErrorClassification, original: unknown, visibleAssistantDeltaEmitted: boolean) {
		super(errorMessage(original));
		this.name = "CursorCliFailoverError";
		this.classification = classification;
		this.original = original;
		this.visibleAssistantDeltaEmitted = visibleAssistantDeltaEmitted;
	}
}

class CursorCliNoAssistantOutputError extends Error {
	constructor() {
		super("Cursor CLI attempt completed without visible assistant text");
		this.name = "CursorCliNoAssistantOutputError";
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	const message = record(error)?.message;
	return typeof message === "string" ? message : "Cursor CLI attempt failed";
}

function errorInput(error: unknown): CursorCliErrorInput {
	const value = record(error);
	if (value && ("exitCode" in value || "stderr" in value || "resultEvent" in value || "thrown" in value)) {
		return error as CursorCliErrorInput;
	}
	return { thrown: error };
}

function defaultErrorFromEvent<TEvent>(event: TEvent): CursorCliErrorInput | undefined {
	const value = record(event);
	if (value?.type === "malformed_stream") return { thrown: event };
	if (value?.type === "result" && (value.is_error === true || value.subtype === "error")) {
		return { resultEvent: event };
	}
	return undefined;
}

function defaultIsVisibleAssistantDelta<TEvent>(event: TEvent): boolean {
	const value = record(event);
	if (!value) return false;
	if (value.type === "assistant") {
		const message = record(value.message);
		if (!Array.isArray(message?.content)) return false;
		return message.content.some((item) => {
			const block = record(item);
			return block?.type === "text" && typeof block.text === "string" && block.text.length > 0;
		});
	}
	return (
		(value.type === "assistant_delta" || value.type === "text_delta") &&
		typeof value.delta === "string" &&
		value.delta.length > 0
	);
}

function notice(fromAccount: string, toAccount: string): CursorCliFailoverNotice {
	return {
		type: "cursor_account_changed",
		message: `Cursor account changed from '${fromAccount}' to '${toAccount}'; a fresh chat was started and prior context was not carried over.`,
		fromAccount,
		toAccount,
		freshChat: true,
		priorContextCarriedOver: false,
	};
}

async function readCredential(
	store: CredentialStore,
	providerId: string,
): Promise<CursorCliOauthCredential | undefined> {
	const current = await store.read(providerId);
	return current?.type === "oauth" ? (current as CursorCliOauthCredential) : undefined;
}

async function selectStoredAccount(
	options: Pick<CursorCliFailoverOptions<never>, "store" | "providerId" | "affinity">,
	now: number,
): Promise<CursorCliAccountSlot> {
	const credential = await readCredential(options.store, options.providerId);
	const accounts = credential ? listAccounts(credential) : [];
	return selectAccount(accounts, {
		...options.affinity,
		pinnedAccount: options.affinity?.pinnedAccount ?? credential?.pinned,
		now,
	});
}

function blockedAccount(
	account: CursorCliAccountSlot,
	classification: CursorCliErrorClassification,
	now: number,
): CursorCliAccountSlot {
	if (classification.kind === "auth_error") {
		const { blockedUntil: _blockedUntil, ...withoutExpiry } = account;
		return { ...withoutExpiry, blockReason: "auth_error" };
	}
	const duration = Math.min(MAX_RATE_LIMIT_BLOCK_MS, classification.blockMs ?? DEFAULT_RATE_LIMIT_BLOCK_MS);
	return { ...account, blockedUntil: now + duration, blockReason: "rate_limit" };
}

async function persistBlock(store: CredentialStore, providerId: string, account: CursorCliAccountSlot): Promise<void> {
	await store.modify(providerId, async (current) => {
		if (current?.type !== "oauth") return current;
		const credential = current as CursorCliOauthCredential;
		return {
			...credential,
			accounts: (credential.accounts ?? []).map((existing) =>
				existing.name === account.name
					? { ...existing, blockedUntil: account.blockedUntil, blockReason: account.blockReason }
					: existing,
			),
		};
	});
}

function isFailoverKind(classification: CursorCliErrorClassification): boolean {
	return classification.kind === "rate_limit" || classification.kind === "auth_error";
}

/**
 * Runs one Cursor CLI stream at a time and rotates accounts only before any
 * assistant text is visible. Replacement accounts always start a fresh chat;
 * this module never accepts or transfers a chat id or transcript context.
 */
export async function* runCursorCliFailover<TEvent>(
	options: CursorCliFailoverOptions<TEvent>,
): AsyncGenerator<TEvent | CursorCliFailoverNotice> {
	const now = options.now ?? Date.now;
	const classify = options.classify ?? classifyCursorCliError;
	const errorFromEvent = options.errorFromEvent ?? defaultErrorFromEvent;
	const isVisibleAssistantDelta = options.isVisibleAssistantDelta ?? defaultIsVisibleAssistantDelta;
	let account = await selectStoredAccount(options, now());
	let freshChat = false;

	while (true) {
		let visibleAssistantDeltaEmitted = false;
		try {
			const attemptStream = await options.runAttempt(account, { freshChat });
			for await (const event of attemptStream) {
				const failure = errorFromEvent(event);
				if (failure !== undefined) throw failure;
				visibleAssistantDeltaEmitted ||= isVisibleAssistantDelta(event);
				yield event;
			}
			if (!visibleAssistantDeltaEmitted) throw new CursorCliNoAssistantOutputError();
			return;
		} catch (error) {
			const classification = classify(errorInput(error));
			const surfaced = new CursorCliFailoverError(classification, error, visibleAssistantDeltaEmitted);
			if (!isFailoverKind(classification)) throw surfaced;

			const blocked = blockedAccount(account, classification, now());
			await persistBlock(options.store, options.providerId, blocked);
			if (visibleAssistantDeltaEmitted) throw surfaced;

			const nextAccount = await selectStoredAccount(options, now());
			yield notice(account.name, nextAccount.name);
			account = nextAccount;
			freshChat = true;
		}
	}
}
