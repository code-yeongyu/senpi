import type { OAuthCredentials } from "../auth/types.ts";

/** Legacy provider identifier accepted by extension OAuth APIs. */
export type OAuthProviderId = string;

/** Legacy extension OAuth prompt. */
export interface OAuthPrompt {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
	/**
	 * Per-prompt cancellation, forwarded from `AuthPrompt.signal`: a provider
	 * aborts it when an out-of-band step resolves the flow, e.g. a manual-code
	 * prompt raced against a local callback server.
	 */
	signal?: AbortSignal;
}

/** Legacy extension OAuth authorization link. */
export interface OAuthAuthInfo {
	url: string;
	instructions?: string;
}

/** Legacy extension OAuth device-code notification. */
export interface OAuthDeviceCodeInfo {
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
}

export interface OAuthSelectOption {
	id: string;
	label: string;
	description?: string;
}

export interface OAuthSelectPrompt {
	message: string;
	options: readonly OAuthSelectOption[];
	/** Per-prompt cancellation, forwarded from `AuthPrompt.signal`. */
	signal?: AbortSignal;
}

/** Callback surface retained only for coding-agent extension compatibility. */
export interface OAuthLoginCallbacks {
	onAuth(info: OAuthAuthInfo): void;
	onDeviceCode(info: OAuthDeviceCodeInfo): void;
	onPrompt(prompt: OAuthPrompt): Promise<string>;
	onProgress?(message: string): void;
	onManualCodeInput?(): Promise<string>;
	onSelect(prompt: OAuthSelectPrompt): Promise<string | undefined>;
	signal?: AbortSignal;
}

export type { OAuthCredentials };
