import { Container, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import type { EntryRenderer, EntryRendererOptions, ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { CustomEntry } from "../../src/core/session-manager.ts";
import { CustomEntryComponent } from "../../src/modes/interactive/components/custom-entry.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

// Regression for #2051: one transcript card per cache-warm wait cycle.
const ENTRY_TYPE = "goal-cache-warmup";

function goalRegistration(): { renderer: EntryRenderer; options: EntryRendererOptions | undefined } {
	let registered: { renderer: EntryRenderer; options: EntryRendererOptions | undefined } | undefined;
	const pi = {
		registerTool: () => {},
		registerCommand: () => {},
		registerEntryRenderer: (type: string, renderer: EntryRenderer, options?: EntryRendererOptions) => {
			if (type === ENTRY_TYPE) registered = { renderer, options };
		},
		on: () => {},
		events: { on: () => () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;
	goalExtension(pi);
	if (registered === undefined) throw new Error("goal extension did not register the cache-warm renderer");
	return registered;
}

function entry(id: string, data: Record<string, unknown>): CustomEntry<unknown> {
	return { type: "custom", id, parentId: null, timestamp: new Date(0).toISOString(), customType: ENTRY_TYPE, data };
}

function scheduled(id: string, goalId: string | undefined, dueAtMs: number): CustomEntry<unknown> {
	return entry(id, { phase: "scheduled", goalId, delayMs: 270_000, dueAtMs, iteration: 1, activeMonitorCount: 1 });
}

function resumed(id: string, goalId: string): CustomEntry<unknown> {
	return entry(id, {
		phase: "resumed",
		goalId,
		delayMs: 270_000,
		dueAtMs: 270_000,
		waitedMs: 270_000,
		iteration: 1,
		activeMonitorCount: 1,
	});
}

function transcript() {
	const { renderer, options } = goalRegistration();
	const chatContainer = new Container();
	const addCustomEntryToChat = Reflect.get(InteractiveMode.prototype, "addCustomEntryToChat") as (
		this: object,
		item: CustomEntry<unknown>,
	) => void;
	const fakeThis: Record<string, unknown> = {
		chatContainer,
		lastStatusText: undefined,
		lastStatusSpacer: undefined,
		toolOutputExpanded: false,
		streamingComponent: undefined,
		session: {
			extensionRunner: {
				getEntryRenderer: (type: string) => (type === ENTRY_TYPE ? renderer : undefined),
				getEntryRendererOptions: (type: string) => (type === ENTRY_TYPE ? options : undefined),
			},
		},
	};
	return {
		chatContainer,
		add: (item: CustomEntry<unknown>) => addCustomEntryToChat.call(fakeThis, item),
		status: (message: string) => {
			const text = new Text(message, 0, 0);
			chatContainer.addChild(text);
			fakeThis.lastStatusText = text;
		},
		cards: () =>
			chatContainer.children.filter((child): child is CustomEntryComponent => child instanceof CustomEntryComponent),
		text: () => chatContainer.render(160).join("\n"),
	};
}

describe("goal cache-warm transcript card (#2051)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("turns the wait card into the wake card instead of stacking a second card", () => {
		const view = transcript();
		view.add(scheduled("s1", "goal-a", 270_000));
		view.add(resumed("r1", "goal-a"));

		expect(view.cards()).toHaveLength(1);
		expect(view.text()).toContain("Cache-warm wake");
		expect(view.text()).not.toContain("Cache-warm wait");
	});

	it("collapses consecutive wait entries for one goal to the latest one on replay", () => {
		const view = transcript();
		view.add(scheduled("s1", "goal-a", 270_000));
		view.add(scheduled("s2", "goal-a", 400_000));
		view.add(scheduled("s3", "goal-a", 403_000));

		expect(view.cards()).toHaveLength(1);
		expect(view.cards()[0]?.customEntry.id).toBe("s3");
	});

	it("keeps separate cards when something visible sits between them or the goal differs", () => {
		const view = transcript();
		view.add(scheduled("s1", "goal-a", 270_000));
		view.chatContainer.addChild(new Text("assistant output", 0, 0));
		view.add(scheduled("s2", "goal-a", 540_000));
		view.add(scheduled("s3", "goal-b", 540_000));

		expect(view.cards().map((card) => card.customEntry.id)).toEqual(["s1", "s2", "s3"]);
	});

	it("updates the card above a status line instead of adding one below it", () => {
		const view = transcript();
		view.add(scheduled("s1", "goal-a", 270_000));
		view.status("Reloaded keybindings, extensions, skills, prompts, themes, and context files");
		view.add(resumed("r1", "goal-a"));

		expect(view.cards()).toHaveLength(1);
		expect(view.chatContainer.children.indexOf(view.cards()[0] as CustomEntryComponent)).toBe(0);
		expect(view.text()).toContain("Cache-warm wake");
	});

	it("never merges legacy entries that carry no goal id", () => {
		const view = transcript();
		view.add(scheduled("s1", undefined, 270_000));
		view.add(scheduled("s2", undefined, 540_000));

		expect(view.cards()).toHaveLength(2);
	});
});
