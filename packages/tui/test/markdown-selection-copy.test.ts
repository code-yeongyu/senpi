import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, it } from "node:test";
import { clearRenderCache, Markdown } from "../src/components/markdown.ts";
import { Box } from "../src/components/box.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Spacer } from "../src/components/spacer.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { Container } from "../src/tui.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { FrameTerminal } from "./frame-terminal.ts";

beforeEach(() => setCapabilities({ hyperlinks: false, images: null, trueColor: true }));
afterEach(() => resetCapabilitiesCache());

it("preserves the pinned renderer's exact ANSI bytes at four widths", () => {
	// Captured from both Markdown and utils at 87f05caa96eb4a3c8d42386df44ecf0c45b2db82.
	// This guards the terminal byte contract, including padding and wrap resets.
	const source =
		"# Heading **bold**\n\nParagraph *italic* and `code` 中文👩🏽‍💻.\n\n+ nested\n  7) second item\n\n~~~ts\n\tconst x = 1;\n~~~\n\n| **A** | B |\n| --- | --- |\n| wrapped words here | 中文 |\n\n[label](https://example.com)";
	const frames = [8, 12, 24, 60].map((width) => new Markdown(source, 1, 1, defaultMarkdownTheme).render(width));
	assert.equal(
		createHash("sha256").update(JSON.stringify(frames)).digest("hex"),
		"ea6a2e6f9be6148b9ace3d485dede4e6969f3276f8fe8041537f14b3cb375547",
	);
});

it("copies original Markdown from a paragraph and list through public mouse input", async () => {
	const source = "A **bold** and *italic* `code` paragraph.\n\n+ List **item**";
	const terminal = new FrameTerminal(60, 8);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	tui.addChild(new Markdown(source, 0, 0, defaultMarkdownTheme));
	try {
		await terminal.frame(() => tui.start());
		assert.deepEqual(
			terminal
				.getViewport()
				.slice(0, 3)
				.map((line) => line.trimEnd()),
			["A bold and italic code paragraph.", "", "- List item"],
		);
		await terminal.frame(() => {
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;11;3M");
			terminal.sendInput("\x1b[<0;11;3m");
		});
		assert.deepEqual(copied, [source]);
	} finally {
		tui.stop();
	}
});

const cases = [
	{ name: "heading", source: "# Heading", end: [7, 1], expected: "# Heading" },
	{ name: "visible heading prefix", source: "### Heading", end: [2, 1], expected: "##" },
	{ name: "visible heading body", source: "### Heading", start: [5, 1], end: [11, 1], expected: "Heading" },
	{ name: "setext heading", source: "Heading\r\n=======", end: [7, 1], expected: "Heading\r\n=======" },
	{ name: "interior emphasis", source: "pre **repeat** end", start: [6, 1], end: [9, 1], expected: "epea" },
	{
		name: "repeated occurrences",
		source: "**repeat** *repeat* `repeat`",
		start: [5, 1],
		end: [9, 1],
		expected: "at** *re",
	},
	{ name: "tabs and CRLF", source: "a\t**b**\r\n\r\n+ c", end: [3, 3], expected: "a\t**b**\r\n\r\n+ c" },
	{
		name: "soft wraps",
		source: "**alpha beta gamma delta**",
		width: 12,
		end: [11, 2],
		expected: "**alpha beta gamma delta**",
	},
	{
		name: "partial soft wrap",
		source: "**alpha beta gamma delta**",
		width: 12,
		start: [8, 1],
		end: [3, 2],
		expected: "eta gam",
	},
	{
		name: "nested list dedent",
		source: "+ outer\n  7) **nested** words\n     continuation",
		end: [19, 3],
		expected: "+ outer\n  7) **nested** words\n     continuation",
	},
	{
		name: "tight task list",
		source: "- [x] **done**\n- [ ] next",
		end: [10, 2],
		expected: "- [x] **done**\n- [ ] next",
	},
	{ name: "indented code", source: "    alpha\n    beta", end: [6, 3], expected: "    alpha\n    beta" },
	{
		name: "link label interior",
		source: "[repeat](https://example.com)",
		start: [2, 1],
		end: [5, 1],
		expected: "epea",
	},
	{
		name: "complete link",
		source: "[repeat](https://example.com)",
		end: [28, 1],
		expected: "[repeat](https://example.com)",
	},
	{
		name: "complete image",
		source: '![diagram](https://example.com/image.png "title")',
		end: [7, 1],
		expected: '![diagram](https://example.com/image.png "title")',
	},
	{
		name: "lazy list continuation",
		source: "+ first\n second **line**",
		end: [14, 2],
		expected: "+ first\n second **line**",
	},
	{ name: "blockquote", source: "> **quoted**\n> text", end: [6, 2], expected: "> **quoted**\n> text" },
	{
		name: "table",
		source: "| **A** | B |\n| --- | --- |\n| c | d |",
		end: [9, 5],
		expected: "| **A** | B |\n| --- | --- |\n| c | d |",
	},
	{
		name: "table cell interior",
		source: "| **repeat** | B |\n| --- | --- |\n| c | d |",
		start: [4, 2],
		end: [7, 2],
		expected: "epea",
	},
	{
		name: "multiline inline code normalization",
		source: "pre `` abc\n def `` end",
		start: [6, 1],
		end: [10, 1],
		expected: "bc\n d",
	},
	{
		name: "hard word wrap",
		source: "**abcdefghijklmnop**",
		width: 8,
		start: [5, 1],
		end: [4, 2],
		expected: "efghijkl",
	},
	{
		name: "source spaces after a cached tab render",
		source: "a   **b**\r\n\r\n+ c",
		end: [3, 3],
		expected: "a   **b**\r\n\r\n+ c",
	},
	{ name: "CJK second cells", source: "prefix **中文测试** end", start: [9, 1], end: [10, 1], expected: "中文" },
	{ name: "emoji and combining marks", source: "**A👩🏽‍💻e\u0301Z**", start: [3, 1], end: [4, 1], expected: "👩🏽‍💻e\u0301" },
	{
		name: "fenced code",
		source: "~~~ts\r\n\tconst x = 1;\r\n~~~",
		end: [3, 3],
		expected: "~~~ts\r\n\tconst x = 1;\r\n~~~",
	},
	{ name: "partial inline code", source: "pre `abc def` post", start: [6, 1], end: [9, 1], expected: "bc d" },
] as const;

for (const fixture of cases) {
	it(`copies ${fixture.name} exactly`, async () => {
		const terminal = new FrameTerminal("width" in fixture ? fixture.width : 60, 12);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Markdown(fixture.source, 0, 0, defaultMarkdownTheme));
		try {
			await terminal.frame(() => tui.start());
			const [x, y] = "start" in fixture ? fixture.start : [1, 1];
			const [endX, endY] = fixture.end;
			await terminal.frame(() => {
				terminal.sendInput(`\x1b[<0;${x};${y}M`);
				terminal.sendInput(`\x1b[<32;${endX};${endY}M`);
				terminal.sendInput(`\x1b[<0;${endX};${endY}m`);
			});
			assert.deepEqual(copied, [fixture.expected], JSON.stringify(terminal.getViewport()));
		} finally {
			tui.stop();
		}
	});
}

it("keeps repeated messages separate on cache hits and reverse selection through padded composition", async () => {
	const terminal = new FrameTerminal(40, 10);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	const container = new Container();
	for (let index = 0; index < 2; index++) {
		const box = new Box(2, 1);
		box.addChild(new Markdown("**same**", 1, 0, defaultMarkdownTheme));
		box.render(40);
		container.addChild(box);
	}
	tui.setLayoutRoot(new ScrollView(container));
	try {
		await terminal.frame(() => tui.start());
		await terminal.frame(() => {
			terminal.sendInput("\x1b[<0;7;5M");
			terminal.sendInput("\x1b[<32;4;2M");
			terminal.sendInput("\x1b[<0;4;2m");
		});
		assert.deepEqual(copied, ["**same**\n**same**"]);
	} finally {
		tui.stop();
	}
});

// senpi#5617: unmapped text keeps its hard blank lines; layout gaps are not source text.
for (const padded of [false, true]) {
	it(`preserves plain-text blank lines beside Markdown with ${padded ? "padded" : "direct"} composition`, async () => {
		const terminal = new FrameTerminal(40, 20);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const text = new Text("alpha\n\nbeta", 0, padded ? 1 : 0);
		const markdown = new Markdown("**tail**", 0, padded ? 1 : 0, defaultMarkdownTheme);
		if (padded) {
			const box = new Box(0, 1);
			box.addChild(new VStack([text, new Spacer(1), markdown], { gap: 1 }));
			tui.setLayoutRoot(new ScrollView(box));
		} else {
			tui.addChild(text);
			tui.addChild(markdown);
		}
		try {
			await terminal.frame(() => tui.start());
			const viewport = terminal.getViewport();
			const first = viewport.findIndex((line) => line.includes("alpha"));
			const last = viewport.findIndex((line) => line.includes("tail"));
			assert.ok(first >= 0 && last > first);
			const start = `${viewport[first].indexOf("alpha") + 1};${first + 1}`;
			const end = `${viewport[last].indexOf("tail") + 4};${last + 1}`;
			await terminal.frame(() => {
				terminal.sendInput(`\x1b[<0;${start}M`);
				terminal.sendInput(`\x1b[<32;${end}M`);
				terminal.sendInput(`\x1b[<0;${end}m`);
			});
			assert.deepEqual(copied, ["alpha\n\nbeta\n**tail**"]);
		} finally {
			tui.stop();
		}
	});
}

// senpi#5617: a retained Box frame must not adopt a later equal-looking source.
it("preserves retained Box provenance through a direct ScrollView child", async () => {
	const terminal = new FrameTerminal(40, 8);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	const markdown = new Markdown("__same__", 0, 0, defaultMarkdownTheme);
	const box = new Box(1, 0);
	box.addChild(markdown);
	const visible = box.render(40);
	tui.setLayoutRoot(new ScrollView({ render: () => visible, invalidate: () => {} }));
	try {
		await terminal.frame(() => tui.start());
		markdown.setText("**same**");
		box.render(40);
		await terminal.frame(() => {
			terminal.sendInput("\x1b[<0;2;1M");
			terminal.sendInput("\x1b[<32;5;1M");
			terminal.sendInput("\x1b[<0;5;1m");
		});
		assert.deepEqual(copied, ["__same__"]);
	} finally {
		tui.stop();
	}
});

it("reports source unavailable without invoking clipboard for a changed display transform", async () => {
	const terminal = new FrameTerminal(60, 5);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	tui.addChild(
		new Markdown("original", 0, 0, defaultMarkdownTheme, undefined, {
			transform: () => "**changed**",
		}),
	);
	try {
		await terminal.frame(() => tui.start());
		await terminal.frame(() => {
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;7;1M");
			terminal.sendInput("\x1b[<0;7;1m");
		});
		assert.deepEqual(copied, []);
		assert.ok(terminal.getViewport().some((line) => line.includes("Original source unavailable")));
	} finally {
		tui.stop();
	}
});

it("uses current source after identical rendering, streaming updates, and resize", async () => {
	const terminal = new FrameTerminal(60, 8);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copyOnSelect: false,
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	const markdown = new Markdown("__same__", 0, 0, defaultMarkdownTheme);
	const box = new Box(1, 0);
	box.addChild(markdown);
	tui.addChild(box);
	try {
		await terminal.frame(() => tui.start());
		await terminal.frame(() => {
			markdown.setText("**same**");
			tui.requestRender(true);
		});
		await terminal.frame(() => {
			terminal.sendInput("\x1b[<0;2;1M");
			terminal.sendInput("\x1b[<32;5;1M");
			terminal.sendInput("\x1b[<0;5;1m");
		});
		assert.equal(await tui.copyActiveSelectionToClipboard(), true);
		assert.deepEqual(copied, ["**same**"]);
		await terminal.frame(() => {
			markdown.setText("**same** and `new text`");
			terminal.resize(14, 8);
		});
		await terminal.frame(() => {
			terminal.sendInput("\x1b[<0;2;1M");
			terminal.sendInput("\x1b[<32;9;2M");
			terminal.sendInput("\x1b[<0;9;2m");
		});
		assert.equal(await tui.copyActiveSelectionToClipboard(), true);
		assert.deepEqual(copied, ["**same**", "**same** and `new text`"]);
	} finally {
		tui.stop();
	}
});

it("copies the retained visible frame after its component changes and caches are cleared", async () => {
	const terminal = new FrameTerminal(40, 6);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	const markdown = new Markdown("**before**", 0, 0, defaultMarkdownTheme);
	const visible = markdown.render(40);
	tui.addChild({ render: () => visible, invalidate: () => markdown.invalidate() });
	try {
		await terminal.frame(() => tui.start());
		markdown.setText("__after__");
		clearRenderCache();
		await terminal.frame(() => {
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;6;1M");
			terminal.sendInput("\x1b[<0;6;1m");
		});
		assert.deepEqual(copied, ["**before**"]);
	} finally {
		tui.stop();
	}
});

it("copies across an explicit scroll while dragging", async () => {
	const terminal = new FrameTerminal(40, 4);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	const source = "**first**\n\n*second*\n\n`third`\n\nfourth";
	const scroll = new ScrollView(new Markdown(source, 0, 0, defaultMarkdownTheme), { follow: "none" });
	tui.setLayoutRoot(scroll);
	try {
		await terminal.frame(() => tui.start());
		await terminal.frame(() => terminal.sendInput("\x1b[<0;1;1M"));
		await terminal.frame(() => {
			scroll.scrollTo(3);
			tui.requestRender();
		});
		await terminal.frame(() => {
			terminal.sendInput("\x1b[<32;6;4M");
			terminal.sendInput("\x1b[<0;6;4m");
		});
		assert.deepEqual(copied, [source]);
	} finally {
		tui.stop();
	}
});

it("reports unavailable rather than filling unselected holes in a wrapped table", async () => {
	const terminal = new FrameTerminal(18, 10);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	tui.addChild(
		new Markdown("| long words here | other words |\n| --- | --- |\n| c | d |", 0, 0, defaultMarkdownTheme),
	);
	try {
		await terminal.frame(() => tui.start());
		await terminal.frame(() => {
			terminal.sendInput("\x1b[<0;3;2M");
			terminal.sendInput("\x1b[<32;16;2M");
			terminal.sendInput("\x1b[<0;16;2m");
		});
		assert.deepEqual(copied, []);
		assert.equal(tui.hasActiveSelection(), true);
		assert.equal(await tui.copyActiveSelectionToClipboard(), false);
	} finally {
		tui.stop();
	}
});

it("preserves original link syntax with OSC 8 hyperlinks enabled", async () => {
	setCapabilities({ hyperlinks: true, images: null, trueColor: true });
	const terminal = new FrameTerminal(40, 6);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	tui.addChild(new Markdown('[**label**](https://example.com "title")', 0, 0, defaultMarkdownTheme));
	try {
		await terminal.frame(() => tui.start());
		await terminal.frame(() => {
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;5;1M");
			terminal.sendInput("\x1b[<0;5;1m");
		});
		assert.deepEqual(copied, ['[**label**](https://example.com "title")']);
	} finally {
		tui.stop();
	}
});
