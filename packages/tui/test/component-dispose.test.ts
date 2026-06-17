import assert from "node:assert";
import { afterEach, describe, it, mock } from "node:test";
import { type Component, Container, Loader, TUI } from "../src/index.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class DisposeSpy implements Component {
	disposeCount = 0;

	render(_width: number): string[] {
		return ["spy"];
	}

	invalidate(): void {}

	dispose(): void {
		this.disposeCount += 1;
	}
}

describe("component disposal lifecycle", () => {
	afterEach(() => {
		mock.timers.reset();
	});

	it("disposes children on removeChild and clear", () => {
		const container = new Container();
		const first = new DisposeSpy();
		const second = new DisposeSpy();

		container.addChild(first);
		container.addChild(second);
		container.removeChild(first);
		container.clear();

		assert.equal(first.disposeCount, 1);
		assert.equal(second.disposeCount, 1);
	});

	it("detaches children without disposing reusable instances", () => {
		const container = new Container();
		const first = new DisposeSpy();
		const second = new DisposeSpy();

		container.addChild(first);
		container.addChild(second);
		container.detachChild(first);
		container.detachAll();

		assert.equal(first.disposeCount, 0);
		assert.equal(second.disposeCount, 0);
		assert.equal(container.children.length, 0);
	});

	it("recursively disposes nested children once", () => {
		const outer = new Container();
		const inner = new Container();
		const leaf = new DisposeSpy();
		inner.addChild(leaf);
		outer.addChild(inner);

		outer.dispose();
		outer.dispose();

		assert.equal(leaf.disposeCount, 1);
	});

	it("stops loader animation when container is cleared", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		const terminal = new VirtualTerminal(40, 4);
		const tui = new TUI(terminal);
		let renderRequests = 0;
		tui.requestRender = () => {
			renderRequests += 1;
		};
		let tick = 0;
		const loader = new Loader(
			tui,
			(frame) => `${frame}${tick++}`,
			(message) => message,
			"loading",
			{ frames: ["1", "2"], intervalMs: 5 },
		);
		const container = new Container();
		container.addChild(loader);

		mock.timers.tick(20);
		const beforeClear = renderRequests;
		assert.ok(beforeClear > 0);

		container.clear();
		mock.timers.tick(100);

		assert.equal(renderRequests, beforeClear);
	});
});
