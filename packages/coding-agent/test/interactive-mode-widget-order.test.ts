import { beforeAll, describe, expect, test } from "vitest";
import { Container } from "../../tui/src/tui.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type WidgetComponent = Container & { dispose?(): void };

type WidgetThis = {
	extensionWidgetsAbove: Map<string, WidgetComponent>;
	extensionWidgetsBelow: Map<string, WidgetComponent>;
	widgetContainerAbove: Container;
	widgetContainerBelow: Container;
	ui: { requestRender(): void };
	renderWidgets(): void;
	renderWidgetContainer(
		container: Container,
		widgets: Map<string, WidgetComponent>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void;
};

type WidgetPrototype = {
	setExtensionWidget(
		this: WidgetThis,
		key: string,
		content: string[] | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	renderWidgets(this: WidgetThis): void;
	renderWidgetContainer(
		this: WidgetThis,
		container: Container,
		widgets: Map<string, WidgetComponent>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void;
};

const prototype = InteractiveMode.prototype as unknown as WidgetPrototype;

function createWidgetThis(): WidgetThis {
	const self: WidgetThis = {
		extensionWidgetsAbove: new Map(),
		extensionWidgetsBelow: new Map(),
		widgetContainerAbove: new Container(),
		widgetContainerBelow: new Container(),
		ui: { requestRender: () => {} },
		renderWidgets: () => prototype.renderWidgets.call(self),
		renderWidgetContainer: (container, widgets, spacerWhenEmpty, leadingSpacer) =>
			prototype.renderWidgetContainer.call(self, container, widgets, spacerWhenEmpty, leadingSpacer),
	};
	return self;
}

function setWidget(
	self: WidgetThis,
	key: string,
	content: string[] | undefined,
	options?: { placement?: "aboveEditor" | "belowEditor" },
): void {
	prototype.setExtensionWidget.call(self, key, content, options);
}

function renderedRows(container: Container, width = 120): string[] {
	return container.children.flatMap((child) => child.render(width)).map((row) => row.trim());
}

describe("InteractiveMode.setExtensionWidget stacking order", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("keeps belowEditor stacking order stable when an existing widget updates", () => {
		const self = createWidgetThis();
		const below = { placement: "belowEditor" as const };

		setWidget(self, "omo-dag", ["dag header"], below);
		setWidget(self, "omo-task", ["task row"], below);
		setWidget(self, "omo-dag", ["dag header v2"], below);

		expect(renderedRows(self.widgetContainerBelow)).toEqual(["dag header v2", "task row"]);
	});

	test("keeps aboveEditor stacking order stable across repeated updates of both widgets", () => {
		const self = createWidgetThis();

		setWidget(self, "first", ["first v1"]);
		setWidget(self, "second", ["second v1"]);
		setWidget(self, "first", ["first v2"]);
		setWidget(self, "second", ["second v2"]);

		// The above container renders a leading spacer before widgets.
		expect(renderedRows(self.widgetContainerAbove)).toEqual(["", "first v2", "second v2"]);
	});

	test("removal does not disturb the remaining widgets' order", () => {
		const self = createWidgetThis();
		const below = { placement: "belowEditor" as const };

		setWidget(self, "one", ["one"], below);
		setWidget(self, "two", ["two"], below);
		setWidget(self, "three", ["three"], below);
		setWidget(self, "one", undefined, below);

		expect(renderedRows(self.widgetContainerBelow)).toEqual(["two", "three"]);
	});

	test("moving a widget to the other placement removes it from the previous container", () => {
		const self = createWidgetThis();
		const below = { placement: "belowEditor" as const };

		setWidget(self, "pinned", ["pinned"], below);
		setWidget(self, "mover", ["mover above"]);
		setWidget(self, "mover", ["mover below"], below);

		expect(renderedRows(self.widgetContainerBelow)).toEqual(["pinned", "mover below"]);
		expect(renderedRows(self.widgetContainerAbove)).toEqual([""]);
	});
});
