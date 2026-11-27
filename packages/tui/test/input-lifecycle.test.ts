import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Input } from "../src/components/input.ts";
import { Container } from "../src/tui.ts";

// senpi#5108: private-input teardown must not change reusable ordinary input behavior.
describe("Input container lifecycle", () => {
	for (const removal of ["clear", "removeChild"] as const) {
		it(`preserves ordinary editing state and callbacks across ${removal} and re-add`, () => {
			const container = new Container();
			const input = new Input();
			let escaped = 0;
			let submitted: string | undefined;
			input.onEscape = () => {
				escaped += 1;
			};
			input.onSubmit = (value) => {
				submitted = value;
			};
			container.addChild(input);
			input.handleInput("abc");
			input.handleInput("\x1b[D");
			input.handleInput("\x0b");

			if (removal === "clear") container.clear();
			else container.removeChild(input);
			container.addChild(input);

			assert.equal(input.getValue(), "ab");
			input.handleInput("\x1b");
			assert.equal(escaped, 1);
			input.handleInput("\x1f");
			assert.equal(input.getValue(), "abc");
			input.handleInput("X");
			assert.equal(input.getValue(), "abXc");
			input.handleInput("\x19");
			assert.equal(input.getValue(), "abXcc");
			input.handleInput("\r");
			assert.equal(submitted, "abXcc");
		});
	}

	it("scrubs secret editing state and callbacks when its container is disposed", () => {
		const container = new Container();
		const input = new Input({ secret: true });
		let callbackCalls = 0;
		input.onEscape = input.onSubmit = () => {
			callbackCalls += 1;
		};
		container.addChild(input);
		input.handleInput("synthetic-secret");
		input.handleInput("\x01");
		input.handleInput("\x0b");
		input.handleInput("private");
		input.handleInput("\x1b[200~unfinished");

		container.dispose();

		assert.equal(input.getValue(), "");
		input.handleInput("\x1f");
		input.handleInput("\x19");
		input.handleInput("\x1b[201~");
		assert.equal(input.getValue(), "");
		input.handleInput("\x1b");
		input.handleInput("\r");
		assert.equal(callbackCalls, 0);
		input.handleInput("x");
		input.handleInput("\x1b[D");
		input.handleInput("y");
		assert.equal(input.getValue(), "yx");
	});
});
