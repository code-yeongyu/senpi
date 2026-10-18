import { describe, expect, it } from "vitest";
import { observeSessionSyncDecision } from "../src/core/extensions/builtin/anthropic-subscription/session-observability.ts";

describe("Claude SDK OAuth observability telemetry", () => {
	it("includes payloadBytes and collapsedDirectives for cold-seed (flatten) observations", () => {
		const observation = observeSessionSyncDecision({
			kind: "cold-seed",
			reason: "transcript_missing",
			deltaMessages: 5,
			firstTurn: false,
			senpiSessionId: "sess-1",
			payloadBytes: 214328,
			collapsedDirectives: 4,
		});

		expect(observation).toEqual({
			kind: "flatten",
			reason: "transcript_missing",
			deltaMessages: 5,
			payloadBytes: 214328,
			collapsedDirectives: 4,
		});
	});

	it("includes telemetry for bootstrap (first-turn cold-seed)", () => {
		const observation = observeSessionSyncDecision({
			kind: "cold-seed",
			reason: "registry_miss",
			deltaMessages: 1,
			firstTurn: true,
			senpiSessionId: "sess-1",
			payloadBytes: 50000,
			collapsedDirectives: 0,
		});

		expect(observation).toEqual({
			kind: "bootstrap",
			reason: "registry_miss",
			deltaMessages: 1,
			payloadBytes: 50000,
			collapsedDirectives: 0,
		});
	});

	it("does NOT include telemetry for delta (incremental) observations", () => {
		const observation = observeSessionSyncDecision({
			kind: "incremental",
			deltaMessages: 3,
			firstTurn: false,
			senpiSessionId: "sess-1",
			payloadBytes: 999,
			collapsedDirectives: 999,
		});

		expect(observation).toEqual({
			kind: "delta",
			reason: "prefix_matched",
			deltaMessages: 3,
		});
	});

	it("does NOT include telemetry for fork (resume) observations", () => {
		const observation = observeSessionSyncDecision({
			kind: "resume",
			reason: "history_rolled_back",
			deltaMessages: 2,
			firstTurn: false,
			senpiSessionId: "sess-1",
			payloadBytes: 999,
			collapsedDirectives: 999,
		});

		expect(observation).toMatchObject({ kind: "fork", reason: "history_rolled_back" });
		expect(observation).not.toHaveProperty("payloadBytes");
		expect(observation).not.toHaveProperty("collapsedDirectives");
	});
});
