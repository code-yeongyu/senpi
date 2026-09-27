import assert from "node:assert/strict";
import { it } from "node:test";
import { Text } from "../src/components/text.ts";
import {
	getCapabilities,
	resetCapabilitiesCache,
	setCapabilities,
	setCapabilityOverrides,
	type TerminalCapabilities,
} from "../src/terminal-image.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class CachedText extends Text {
	invalidations = 0;

	override invalidate(): void {
		this.invalidations++;
		super.invalidate();
	}
}

async function withTerminal(check: (tui: TUI, terminal: VirtualTerminal, text: CachedText) => Promise<void>) {
	setCapabilityOverrides({ images: null, trueColor: true, hyperlinks: false });
	const terminal = new VirtualTerminal(80, 24);
	const tui = new TUI(terminal);
	const text = new CachedText("cached transcript", 0, 0);
	tui.addChild(text);
	try {
		tui.start();
		tui.renderNow();
		await terminal.flush();
		await check(tui, terminal, text);
	} finally {
		tui.stop();
		setCapabilityOverrides({});
		resetCapabilitiesCache();
	}
}

it("keeps transcript caches without replaying history on unchanged-capability focus transitions", async () => {
	await withTerminal(async (tui, terminal, text) => {
		const cached = text.render(80);
		const fullRedraws = tui.fullRedraws;
		for (const focus of ["\x1b[I", "\x1b[O"]) {
			terminal.sendInput(focus);
			tui.renderNow();
			await terminal.flush();
			assert.equal(text.invalidations, 0);
			assert.equal(tui.fullRedraws, fullRedraws);
			assert.strictEqual(text.render(80), cached);
			assert.ok(terminal.getViewport().some((line) => line.includes("cached transcript")));
		}
	});
});

const changedCapabilities: Partial<TerminalCapabilities>[] = [
	{ images: "kitty" },
	{ trueColor: false },
	{ hyperlinks: true },
	{ tmuxPassthrough: true },
	{ kittyUnicodePlaceholders: true },
];
for (const changed of changedCapabilities) {
	it(`invalidates layout after focus refresh changes ${Object.keys(changed)[0]}`, async () => {
		await withTerminal(async (tui, terminal, text) => {
			const expected = getCapabilities();
			const cached = text.render(80);
			const fullRedraws = tui.fullRedraws;
			setCapabilities({ ...expected, ...changed });
			terminal.sendInput("\x1b[I");
			tui.renderNow();
			await terminal.flush();
			assert.equal(text.invalidations, 1);
			assert.equal(tui.fullRedraws, fullRedraws + 1);
			assert.notStrictEqual(text.render(80), cached);
			assert.deepEqual(getCapabilities(), expected);
		});
	});
}

for (const [protocol, payload] of [
	["kitty", "\x1b_Ga=T,f=100,i=42;AAAA\x1b\\"],
	["iterm2", "\x1b]1337;File=inline=1:AAAA\x07"],
] as const) {
	it(`retransmits ${protocol} image payloads on focus without invalidating component caches`, async (t) => {
		await withTerminal(async (tui, terminal, text) => {
			setCapabilityOverrides({ images: protocol, trueColor: true, hyperlinks: false });
			getCapabilities();
			tui.addChild({ render: () => [payload], invalidate: () => {} });
			tui.renderNow();
			const writes = t.mock.method(terminal, "write");
			const fullRedraws = tui.fullRedraws;
			terminal.sendInput("\x1b[I");
			tui.renderNow();
			await terminal.flush();
			assert.equal(text.invalidations, 0);
			assert.equal(tui.fullRedraws, fullRedraws + 1);
			assert.ok(writes.mock.calls.some((call) => call.arguments[0].includes(payload)));
		});
	});
}

it("preserves adjacent input while rendering a focus transition from cached history", async () => {
	await withTerminal(async (tui, terminal, text) => {
		const received: string[] = [];
		tui.setFocus({
			render: () => [],
			invalidate: () => {},
			handleInput: (data) => received.push(data),
		});
		terminal.sendInput("\x1b[Iprompt");
		tui.renderNow();
		await terminal.flush();
		assert.deepEqual(received, ["prompt"]);
		assert.equal(text.invalidations, 0);
	});
});
