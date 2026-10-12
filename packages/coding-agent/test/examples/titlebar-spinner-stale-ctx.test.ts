import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";

import titlebarSpinner from "../../examples/extensions/titlebar-spinner.ts";
import {
	RELOAD_STALE_MESSAGE,
	REPLACEMENT_STALE_MESSAGE,
	retirableContext,
} from "../suite/regressions/2549-retirable-context-support.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

const FRAME_INTERVAL_MS = 80;
const BASE_TITLE = `π - spinner-session - ${path.basename(process.cwd())}`;

function loadSpinner(setTitle: (title: string) => void = () => {}) {
	const handlers = new Map<string, EventHandler>();
	const titles: string[] = [];
	const api = {
		getSessionName: () => "spinner-session",
		on: (event: string, handler: EventHandler) => handlers.set(event, handler),
	};
	titlebarSpinner(api as unknown as ExtensionAPI);
	const context = retirableContext({
		cwd: "/tmp/spinner-project",
		sessionId: "spinner-session",
		ui: {
			setTitle: (title: string) => {
				titles.push(title);
				setTitle(title);
			},
		},
	});
	return { handlers, titles, context };
}

async function dispatch(handlers: Map<string, EventHandler>, event: string, ctx: ExtensionContext) {
	const handler = handlers.get(event);
	if (!handler) throw new Error(`the example registered no ${event} handler`);
	await handler({ type: event }, ctx);
}

describe("titlebar-spinner against a retired extension ctx", () => {
	afterEach(() => vi.useRealTimers());

	it.each([
		["a reload", RELOAD_STALE_MESSAGE],
		["a session replacement", REPLACEMENT_STALE_MESSAGE],
	])("stops the spinner instead of throwing out of the interval on %s", async (_label, staleMessage) => {
		vi.useFakeTimers();
		const { handlers, titles, context } = loadSpinner();
		await dispatch(handlers, "agent_start", context.context);
		expect(titles).toHaveLength(1);

		// The interval callback has no catcher above it, so an escaping throw here is the
		// uncaughtException that used to take the whole process down (senpi#2549).
		context.retire(staleMessage);
		expect(() => vi.advanceTimersByTime(FRAME_INTERVAL_MS)).not.toThrow();

		vi.advanceTimersByTime(FRAME_INTERVAL_MS * 10);
		expect(titles).toHaveLength(1);
	});

	it("keeps animating a live session and restores the base title when the agent settles", async () => {
		vi.useFakeTimers();
		const { handlers, titles, context } = loadSpinner();
		await dispatch(handlers, "agent_start", context.context);
		expect(titles[0]).toBe(BASE_TITLE);

		vi.advanceTimersByTime(FRAME_INTERVAL_MS * 3);
		expect(titles).toHaveLength(4);

		await dispatch(handlers, "agent_settled", context.context);
		expect(titles.at(-1)).toBe(BASE_TITLE);

		const rendered = titles.length;
		vi.advanceTimersByTime(FRAME_INTERVAL_MS * 3);
		expect(titles).toHaveLength(rendered);
	});

	it("still surfaces a failure that is not a retired ctx", async () => {
		vi.useFakeTimers();
		let renders = 0;
		const { handlers, context } = loadSpinner(() => {
			renders += 1;
			if (renders > 1) throw new TypeError("the title renderer is broken");
		});
		await dispatch(handlers, "agent_start", context.context);

		expect(() => vi.advanceTimersByTime(FRAME_INTERVAL_MS)).toThrow(TypeError);
	});
});
