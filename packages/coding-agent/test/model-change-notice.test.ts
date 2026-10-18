import { describe, expect, it } from "vitest";
import type { ModelChangeEntry } from "../src/core/session-manager.ts";
import {
	liveModelChangeNotice,
	parseModelCommandArgument,
	replayedModelChangeNotice,
} from "../src/modes/interactive/model-change-notice.ts";

function entry(fields: Partial<ModelChangeEntry>): ModelChangeEntry {
	return {
		type: "model_change",
		id: "e1",
		parentId: null,
		timestamp: "2026-10-07T00:00:00.000Z",
		provider: "p",
		modelId: "next",
		...fields,
	};
}

describe("model change notices (senpi#2870)", () => {
	it("parses /model --default anywhere in the argument and leaves the search term intact", () => {
		expect(parseModelCommandArgument("sonnet")).toEqual({ searchTerm: "sonnet", asDefault: false });
		expect(parseModelCommandArgument("--default anthropic/claude")).toEqual({
			searchTerm: "anthropic/claude",
			asDefault: true,
		});
		expect(parseModelCommandArgument("claude --default")).toEqual({ searchTerm: "claude", asDefault: true });
		expect(parseModelCommandArgument(undefined)).toEqual({ searchTerm: "", asDefault: false });
	});

	it("announces a mid-turn switch with both models and its source, live and on replay alike", () => {
		const live = liveModelChangeNotice({
			duringTurn: true,
			origin: { source: "picker", actor: "favorites" },
			model: { id: "next" },
			previousModel: { id: "main" },
		});
		const replayed = replayedModelChangeNotice(
			entry({ duringTurn: true, source: "picker", actor: "favorites", originalModelId: "main" }),
		);
		expect(live?.text).toBe("⇄ Model changed mid-turn · main → next (picker: favorites)");
		expect(replayed).toEqual(live);
	});

	it("adds nothing for a switch between turns, a fallback (it has its own notice), or a legacy entry", () => {
		expect(liveModelChangeNotice({ duringTurn: false, origin: { source: "command" }, model: { id: "next" } })).toBe(
			undefined,
		);
		expect(liveModelChangeNotice({ duringTurn: true, origin: { source: "fallback" }, model: { id: "next" } })).toBe(
			undefined,
		);
		expect(replayedModelChangeNotice(entry({ duringTurn: true, source: "fallback-revert" }))).toBeUndefined();
		expect(replayedModelChangeNotice(entry({}))).toBeUndefined();
	});
});
