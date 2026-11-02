// #1542: an abort reaching the /login surface (no reason, AbortError, "Login cancelled")
// renders as a neutral "Login cancelled" status, never as a login failure error.
import { describe, expect, it } from "vitest";
import { CredentialSynchronizationError } from "../../../src/core/model-runtime.ts";
import { describeLoginFailure, isLoginCancellation } from "../../../src/modes/interactive/login-outcome.ts";

function dialogEscapeReason(): unknown {
	// LoginDialogComponent.cancel() aborts with no reason: the DOMException whose
	// message is "This operation was aborted" is what the user saw in #1542.
	const controller = new AbortController();
	controller.abort();
	return controller.signal.reason;
}

function fabricatedAbortError(): Error {
	// utils/abort.ts abortReason() for a signal aborted without a reason.
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

describe("login outcome classification (#1542)", () => {
	it("treats every abort-shaped reason as a cancellation", () => {
		expect(isLoginCancellation(dialogEscapeReason())).toBe(true);
		expect(isLoginCancellation(fabricatedAbortError())).toBe(true);
		expect(isLoginCancellation(new Error("Login cancelled"))).toBe(true);
		expect(isLoginCancellation(undefined)).toBe(true);
	});

	it("renders an aborted /login as a neutral notice, not a failure", () => {
		expect(describeLoginFailure(dialogEscapeReason(), "ChatGPT Subscription", "oauth")).toEqual({
			level: "status",
			message: "Login cancelled",
		});
		expect(describeLoginFailure(fabricatedAbortError(), "ChatGPT Subscription", "oauth")).toEqual({
			level: "status",
			message: "Login cancelled",
		});
		expect(describeLoginFailure(new Error("Login cancelled"), "Anthropic", "api_key")).toEqual({
			level: "status",
			message: "Login cancelled",
		});
	});

	it("keeps genuine provider, network and OAuth errors as failures", () => {
		expect(isLoginCancellation(new Error("invalid_grant"))).toBe(false);
		const oauth = describeLoginFailure(
			new Error("token exchange failed (400): invalid_grant"),
			"ChatGPT Subscription",
			"oauth",
		);
		expect(oauth.level).toBe("error");
		expect(oauth.message).toContain("token exchange failed (400): invalid_grant");
		const apiKey = describeLoginFailure(new Error("fetch failed"), "OpenAI", "api_key");
		expect(apiKey.level).toBe("error");
		expect(apiKey.message).toContain("fetch failed");
		expect(isLoginCancellation(Object.assign(new Error("timed out"), { name: "TimeoutError" }))).toBe(false);
	});

	it("keeps the credential synchronization failure message", () => {
		const error = new CredentialSynchronizationError("chatgpt-subscription", "login", undefined, {
			cause: new Error("disk on fire"),
		});
		const notice = describeLoginFailure(error, "ChatGPT Subscription", "oauth");
		expect(notice.level).toBe("error");
		expect(notice.message).toMatch(
			/^Logged in to ChatGPT Subscription, but local model state could not be synchronized: /,
		);
	});
});
