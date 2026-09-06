import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	overrideAuthLaneBoundary,
	queryWithAuthLane,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/auth-lane.ts";
import type {
	Options,
	SDKMessage,
	SdkQuery,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import type { ClaudeSdkOauthTokenInjection } from "../../../src/core/extensions/builtin/claude-sdk-oauth/settings.ts";

const EXPECTED_ERROR =
	"authentication_failed: No Claude SDK OAuth accounts configured for the managed lane; " +
	"run /login claude-sdk-oauth or set CLAUDE_CODE_OAUTH_TOKEN";

async function consume(messages: AsyncGenerator<SDKMessage>): Promise<void> {
	for await (const _message of messages) void _message;
}

function loggedOutLane(lane: ClaudeSdkOauthTokenInjection | undefined): {
	messages: AsyncGenerator<SDKMessage>;
	query: SdkQuery;
} {
	overrideAuthLaneBoundary({
		createStore: () => new InMemoryCredentialStore(),
		env: () => ({ PATH: "/usr/bin" }),
	});
	const query = vi.fn(() => {
		throw new Error("ambient Claude query must not run");
	}) as unknown as SdkQuery;
	const messages = queryWithAuthLane({
		prompt: "resume",
		query,
		buildOptions: () => ({}) as Options,
		providerSettings: lane === undefined ? {} : { tokenInjection: lane },
	});
	return { messages, query };
}

afterEach(() => {
	resetAuthLaneBoundary();
});

describe("LAB-27 Claude OAuth logout", () => {
	for (const lane of ["oauth-slots", "config-dir"] as const) {
		it(`requires login instead of falling back to ambient Claude credentials on the ${lane} lane`, async () => {
			const { messages, query } = loggedOutLane(lane);

			await expect(consume(messages)).rejects.toThrow(EXPECTED_ERROR);
			expect(query).not.toHaveBeenCalled();
		});
	}

	it("still resolves to the ambient lane when no tokenInjection is configured (issue #6784)", async () => {
		const { messages, query } = loggedOutLane(undefined);

		await expect(consume(messages)).rejects.toThrow("ambient Claude query must not run");
		expect(query).toHaveBeenCalledTimes(1);
	});

	it("still resolves to the ambient lane when tokenInjection is explicitly ambient", async () => {
		const { messages, query } = loggedOutLane("ambient");

		await expect(consume(messages)).rejects.toThrow("ambient Claude query must not run");
		expect(query).toHaveBeenCalledTimes(1);
	});
});
