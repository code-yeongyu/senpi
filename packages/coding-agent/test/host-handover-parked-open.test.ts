import { describe, expect, it } from "vitest";
import { parkedEntryFromProfile, parkedOpenCommand } from "../src/modes/rpc/host-handover-parked-open.ts";

describe("a parked session replays its client's open_session choices (senpi#3368)", () => {
	const profile = {
		cwd: "/work",
		creationModel: { provider: "anthropic", modelId: "m" },
		initialThinkingLevel: "high",
		permissionPreset: "ask",
		promptSurface: "app" as const,
		browserEngine: "builtin" as const,
		sessionKind: "worker" as const,
		sessionContext: { lane: "l1", host_instance: "old-host", host_socket: "/old.sock" },
		autoTitle: false,
	};

	it("records the client's choices and strips this host's own context keys", () => {
		const entry = parkedEntryFromProfile({ sessionPath: "/s.jsonl", durableSessionId: "d-1" }, profile, [
			"host_instance",
			"host_socket",
		]);
		expect(entry).toEqual({
			sessionPath: "/s.jsonl",
			durableSessionId: "d-1",
			retainOnDisconnect: true,
			cwd: "/work",
			model: { provider: "anthropic", modelId: "m" },
			thinkingLevel: "high",
			permissionPreset: "ask",
			promptSurface: "app",
			browserEngine: "builtin",
			sessionKind: "worker",
			sessionContext: { lane: "l1" },
			autoTitle: false,
		});
	});

	it("replays them as the open_session a client would send", () => {
		const entry = parkedEntryFromProfile({ sessionPath: "/s.jsonl", durableSessionId: "d-1" }, profile, [
			"host_instance",
			"host_socket",
		]);
		expect(parkedOpenCommand(entry)).toEqual({
			type: "open_session",
			sessionPath: "/s.jsonl",
			cwd: "/work",
			durableSessionId: "d-1",
			provider: "anthropic",
			modelId: "m",
			thinkingLevel: "high",
			permissionPreset: "ask",
			promptSurface: "app",
			browserEngine: "builtin",
			kind: "worker",
			context: { lane: "l1" },
			auto_title: false,
			retain_on_disconnect: true,
		});
	});

	it("drops a context left with only host-owned keys, and an unknown thinking level", () => {
		const entry = parkedEntryFromProfile(
			{ sessionPath: "/s.jsonl" },
			{ cwd: "/w", initialThinkingLevel: "turbo", sessionContext: { host_instance: "old" } },
			["host_instance"],
		);
		expect(entry.sessionContext).toBeUndefined();
		expect(parkedOpenCommand(entry).thinkingLevel).toBeUndefined();
	});
});
