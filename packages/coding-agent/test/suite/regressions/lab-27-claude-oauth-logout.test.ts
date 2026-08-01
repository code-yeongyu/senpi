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

async function consume(messages: AsyncGenerator<SDKMessage>): Promise<void> {
	for await (const _message of messages) void _message;
}

afterEach(() => {
	resetAuthLaneBoundary();
});

describe("LAB-27 Claude OAuth logout", () => {
	it("requires login instead of falling back to ambient Claude credentials", async () => {
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
			providerSettings: { tokenInjection: "oauth-slots" },
		});

		await expect(consume(messages)).rejects.toThrow(
			"No Claude SDK OAuth accounts configured. Add one with /claude-account add.",
		);
		expect(query).not.toHaveBeenCalled();
	});
});
