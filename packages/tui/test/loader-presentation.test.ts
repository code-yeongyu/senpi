import assert from "node:assert/strict";
import { afterEach, it, mock } from "node:test";
import { Loader, TUI } from "../src/index.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

afterEach(() => mock.timers.reset());

it("keeps the default loader message and spinner coloring", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
	const tui = new TUI(new VirtualTerminal(120, 4));
	const loader = new Loader(
		tui,
		(s) => `[spinner:${s}]`,
		(s) => `[message:${s}]`,
	);
	try {
		mock.timers.tick(80);
		assert.ok(loader.render(120).join("").includes("[message:Loading...]"));
		assert.ok(loader.render(120).join("").includes("[spinner:"));
	} finally {
		loader.dispose();
	}
});

it("animates cached content without running its slower formatter again", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
	const tui = new TUI(new VirtualTerminal(120, 4));
	let contentCalls = 0;
	const loader = new Loader(
		tui,
		(s) => s,
		(s) => s,
		"Working",
		{
			frames: [],
			messageIntervalMs: 1000,
			presentationIntervalMs: 80,
			messageFormatter: (s) => {
				contentCalls++;
				return s + ":content";
			},
			presentationFormatter: (s, elapsed) => s + ":" + elapsed,
		},
	);
	try {
		const before = contentCalls;
		mock.timers.tick(80);
		assert.ok(loader.render(120).join("").includes("Working:content:80"));
		assert.equal(contentCalls, before);
		mock.timers.tick(920);
		assert.equal(contentCalls, before + 1);
	} finally {
		loader.dispose();
	}
});

it("stops its presentation timer when replaced by a static indicator", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
	const tui = new TUI(new VirtualTerminal(120, 4));
	let requests = 0;
	tui.requestRender = () => {
		requests++;
	};
	const loader = new Loader(
		tui,
		(s) => s,
		(s) => s,
		"Working",
		{
			frames: ["A", "B"],
			intervalMs: 1000,
			presentationIntervalMs: 80,
			presentationFormatter: (s, elapsed) => s + ":" + elapsed,
		},
	);
	mock.timers.tick(80);
	assert.ok(loader.render(120).join("").includes("A Working:80"));
	loader.setIndicator({ frames: ["•"] });
	const atStop = requests;
	mock.timers.tick(1000);
	assert.equal(requests, atStop);
	loader.dispose();
});

it("preserves message updates and invalidation with animated presentation", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
	const tui = new TUI(new VirtualTerminal(120, 4));
	const loader = new Loader(
		tui,
		(s) => s,
		(s) => s,
		"Before",
		{
			frames: ["•"],
			messageIntervalMs: 1000,
			presentationIntervalMs: 80,
			messageFormatter: (s) => s,
			presentationFormatter: (s, elapsed) => `${s}:${elapsed}`,
		},
	);
	try {
		loader.setMessage("After");
		loader.invalidate();
		mock.timers.tick(80);
		assert.ok(loader.render(120).join("").includes("After:80"));
	} finally {
		loader.dispose();
	}
});

it("uses one cadence when presentation and content intervals match", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
	const tui = new TUI(new VirtualTerminal(120, 4));
	let displays = 0;
	const loader = new Loader(
		tui,
		(s) => s,
		(s) => s,
		"Working",
		{
			frames: [],
			messageIntervalMs: 80,
			messageFormatter: (s) => s,
			presentationFormatter: (s) => {
				displays++;
				return s;
			},
		},
	);
	try {
		const initial = displays;
		mock.timers.tick(80);
		assert.equal(displays, initial + 1);
	} finally {
		loader.dispose();
	}
});

it("animates presentation without a content formatter at the default cadence", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
	const tui = new TUI(new VirtualTerminal(120, 4));
	const loader = new Loader(
		tui,
		(s) => s,
		(s) => s,
		"Working",
		{
			frames: ["•"],
			presentationFormatter: (s, elapsed) => `${s}:${elapsed}`,
		},
	);
	try {
		mock.timers.tick(80);
		assert.ok(loader.render(120).join("").includes("Working:80"));
	} finally {
		loader.dispose();
	}
});
