import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	addAnthropicComputerUseToPayload,
	type ComputerOperations,
	type ComputerToolInput,
	computerSchema,
	createUnsupportedOps,
	executeComputerAction,
	isAnthropicComputerUseEnabled,
} from "../../src/core/extensions/builtin/anthropic-computer-use/index.js";

const ENV_ENABLE = "PI_ANTHROPIC_COMPUTER_USE";
const ENV_WIDTH = "PI_ANTHROPIC_COMPUTER_USE_WIDTH";
const ENV_HEIGHT = "PI_ANTHROPIC_COMPUTER_USE_HEIGHT";
const ENV_DISPLAY = "PI_ANTHROPIC_COMPUTER_USE_DISPLAY_NUMBER";

function setEnabled(width = "1920", height = "1080", enable = "true"): void {
	process.env[ENV_ENABLE] = enable;
	process.env[ENV_WIDTH] = width;
	process.env[ENV_HEIGHT] = height;
}

function clearEnv(): void {
	delete process.env[ENV_ENABLE];
	delete process.env[ENV_WIDTH];
	delete process.env[ENV_HEIGHT];
	delete process.env[ENV_DISPLAY];
}

function makeMockOps(): ComputerOperations & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		screenshot: vi.fn(async () => {
			calls.push("screenshot");
			return { base64: "ZmFrZS1wbmc=" };
		}),
		cursorPosition: vi.fn(async () => {
			calls.push("cursorPosition");
			return { x: 10, y: 20 };
		}),
		mouseMove: vi.fn(async (x: number, y: number) => {
			calls.push(`mouseMove:${x},${y}`);
		}),
		click: vi.fn(async (button: "left" | "right" | "middle", x?: number, y?: number) => {
			calls.push(`click:${button}:${x ?? "n"},${y ?? "n"}`);
		}),
		doubleClick: vi.fn(async (x?: number, y?: number) => {
			calls.push(`doubleClick:${x ?? "n"},${y ?? "n"}`);
		}),
		tripleClick: vi.fn(async (x?: number, y?: number) => {
			calls.push(`tripleClick:${x ?? "n"},${y ?? "n"}`);
		}),
		drag: vi.fn(async (sx: number, sy: number, ex: number, ey: number) => {
			calls.push(`drag:${sx},${sy}->${ex},${ey}`);
		}),
		mouseDown: vi.fn(async (_button: "left", x?: number, y?: number) => {
			calls.push(`mouseDown:${x ?? "n"},${y ?? "n"}`);
		}),
		mouseUp: vi.fn(async (_button: "left", x?: number, y?: number) => {
			calls.push(`mouseUp:${x ?? "n"},${y ?? "n"}`);
		}),
		scroll: vi.fn(async (direction: "up" | "down" | "left" | "right", amount: number, x?: number, y?: number) => {
			calls.push(`scroll:${direction}:${amount}:${x ?? "n"},${y ?? "n"}`);
		}),
		keyPress: vi.fn(async (combo: string) => {
			calls.push(`keyPress:${combo}`);
		}),
		type: vi.fn(async (text: string) => {
			calls.push(`type:${text}`);
		}),
		holdKey: vi.fn(async (combo: string, duration: number) => {
			calls.push(`holdKey:${combo}:${duration}`);
		}),
		wait: vi.fn(async (duration: number) => {
			calls.push(`wait:${duration}`);
		}),
	};
}

afterEach(() => {
	clearEnv();
});

describe("anthropic-computer-use extension", () => {
	it("no-op when env unset", () => {
		const payload = { tools: [{ name: "read" }] };
		expect(addAnthropicComputerUseToPayload("anthropic-messages", payload)).toBe(payload);
	});

	it("no-op when env enabled but dims missing", () => {
		process.env[ENV_ENABLE] = "true";
		const payload = { tools: [{ name: "read" }] };
		expect(addAnthropicComputerUseToPayload("anthropic-messages", payload)).toBe(payload);
	});

	it("no-op when dims invalid", () => {
		process.env[ENV_ENABLE] = "true";
		process.env[ENV_WIDTH] = "-1";
		process.env[ENV_HEIGHT] = "abc";
		const payload = { tools: [{ name: "read" }] };
		expect(addAnthropicComputerUseToPayload("anthropic-messages", payload)).toBe(payload);
	});

	it("no-op when explicitly disabled", () => {
		setEnabled("1920", "1080", "0");
		const payload = { tools: [{ name: "read" }] };
		expect(addAnthropicComputerUseToPayload("anthropic-messages", payload)).toBe(payload);
	});

	it("no-op when api is not anthropic", () => {
		setEnabled();
		const payload = { tools: [{ name: "read" }] };
		expect(addAnthropicComputerUseToPayload("openai-responses", payload)).toBe(payload);
	});

	it("injects native computer tool with width/height", () => {
		setEnabled();
		const result = addAnthropicComputerUseToPayload("anthropic-messages", { tools: [{ name: "grep" }] }) as {
			tools: Array<Record<string, unknown>>;
		};
		expect(result.tools).toContainEqual({
			type: "computer_20250124",
			name: "computer",
			display_width_px: 1920,
			display_height_px: 1080,
		});
	});

	it("includes display_number when set", () => {
		setEnabled();
		process.env[ENV_DISPLAY] = "2";
		const result = addAnthropicComputerUseToPayload("anthropic-messages", { tools: [] }) as {
			tools: Array<Record<string, unknown>>;
		};
		expect(result.tools).toContainEqual({
			type: "computer_20250124",
			name: "computer",
			display_width_px: 1920,
			display_height_px: 1080,
			display_number: 2,
		});
	});

	it("preserves caller-supplied native variant", () => {
		setEnabled();
		const result = addAnthropicComputerUseToPayload("anthropic-messages", {
			tools: [{ type: "computer_20250124", name: "computer", display_width_px: 100, display_height_px: 100 }],
		}) as { tools: Array<Record<string, unknown>> };
		expect(result.tools).toHaveLength(1);
	});

	it("strips function-shape computer tool", () => {
		setEnabled();
		const result = addAnthropicComputerUseToPayload("anthropic-messages", {
			tools: [{ name: "computer", input_schema: { type: "object" } }],
		}) as { tools: Array<Record<string, unknown>> };
		expect(result.tools).toHaveLength(1);
		expect(result.tools[0]?.type).toBe("computer_20250124");
	});

	it("preserves other tools", () => {
		setEnabled();
		const result = addAnthropicComputerUseToPayload("anthropic-messages", {
			tools: [{ name: "read" }, { name: "write" }],
		}) as { tools: Array<Record<string, unknown>> };
		expect(result.tools.some((tool) => tool.name === "read")).toBe(true);
		expect(result.tools.some((tool) => tool.name === "write")).toBe(true);
	});

	it("accepts all actions in schema", () => {
		const actions: Array<ComputerToolInput["action"]> = [
			"screenshot",
			"key",
			"type",
			"mouse_move",
			"left_click",
			"right_click",
			"middle_click",
			"double_click",
			"triple_click",
			"left_click_drag",
			"cursor_position",
			"left_mouse_down",
			"left_mouse_up",
			"scroll",
			"hold_key",
			"wait",
		];
		for (const action of actions) {
			expect(Value.Check(computerSchema, { action })).toBe(true);
		}
	});

	it("invalid action rejected by schema", () => {
		expect(Value.Check(computerSchema, { action: "zoom" })).toBe(false);
	});

	it("mouse_move missing coordinate returns error", async () => {
		const result = await executeComputerAction({ action: "mouse_move" }, makeMockOps());
		expect(result.isError).toBe(true);
	});

	it("screenshot action returns image", async () => {
		const ops = makeMockOps();
		const result = await executeComputerAction({ action: "screenshot" }, ops);
		expect(ops.calls).toEqual(["screenshot"]);
		expect(result.content[0]?.type).toBe("image");
	});

	it("key dispatches keyPress", async () => {
		const ops = makeMockOps();
		await executeComputerAction({ action: "key", text: "ctrl+c" }, ops);
		expect(ops.calls).toContain("keyPress:ctrl+c");
	});

	it("type dispatches type", async () => {
		const ops = makeMockOps();
		await executeComputerAction({ action: "type", text: "hello" }, ops);
		expect(ops.calls).toContain("type:hello");
	});

	it("mouse_move dispatches mouseMove", async () => {
		const ops = makeMockOps();
		await executeComputerAction({ action: "mouse_move", coordinate: [100, 200] }, ops);
		expect(ops.calls).toContain("mouseMove:100,200");
	});

	it("left_click no coordinate dispatches", async () => {
		const ops = makeMockOps();
		await executeComputerAction({ action: "left_click" }, ops);
		expect(ops.calls).toContain("click:left:n,n");
	});

	it("left_click with coordinate dispatches", async () => {
		const ops = makeMockOps();
		await executeComputerAction({ action: "left_click", coordinate: [1, 2] }, ops);
		expect(ops.calls).toContain("click:left:1,2");
	});

	it("right/middle/double/triple dispatch correctly", async () => {
		const ops = makeMockOps();
		await executeComputerAction({ action: "right_click", coordinate: [1, 2] }, ops);
		await executeComputerAction({ action: "middle_click", coordinate: [3, 4] }, ops);
		await executeComputerAction({ action: "double_click", coordinate: [5, 6] }, ops);
		await executeComputerAction({ action: "triple_click", coordinate: [7, 8] }, ops);
		expect(ops.calls).toContain("click:right:1,2");
		expect(ops.calls).toContain("click:middle:3,4");
		expect(ops.calls).toContain("doubleClick:5,6");
		expect(ops.calls).toContain("tripleClick:7,8");
	});

	it("left_click_drag dispatches drag", async () => {
		const ops = makeMockOps();
		await executeComputerAction({ action: "left_click_drag", start_coordinate: [1, 2], coordinate: [3, 4] }, ops);
		expect(ops.calls).toContain("drag:1,2->3,4");
	});

	it("cursor_position returns text format", async () => {
		const ops = makeMockOps();
		const result = await executeComputerAction({ action: "cursor_position" }, ops);
		expect(result.content[0]).toEqual({ type: "text", text: "X=10,Y=20" });
		expect(ops.calls).toEqual(["cursorPosition"]);
	});

	it("mouse down/up dispatch correctly", async () => {
		const ops = makeMockOps();
		await executeComputerAction({ action: "left_mouse_down", coordinate: [10, 11] }, ops);
		await executeComputerAction({ action: "left_mouse_up", coordinate: [12, 13] }, ops);
		expect(ops.calls).toContain("mouseDown:10,11");
		expect(ops.calls).toContain("mouseUp:12,13");
	});

	it("scroll dispatches with amount", async () => {
		const ops = makeMockOps();
		await executeComputerAction(
			{ action: "scroll", scroll_direction: "down", scroll_amount: 4, coordinate: [1, 2] },
			ops,
		);
		expect(ops.calls).toContain("scroll:down:4:1,2");
	});

	it("hold_key dispatches holdKey", async () => {
		const ops = makeMockOps();
		await executeComputerAction({ action: "hold_key", text: "shift", duration: 1.2 }, ops);
		expect(ops.calls).toContain("holdKey:shift:1.2");
	});

	it("wait dispatches wait then screenshot", async () => {
		const ops = makeMockOps();
		await executeComputerAction({ action: "wait", duration: 0.1 }, ops);
		expect(ops.calls[0]).toBe("wait:0.1");
		expect(ops.calls[1]).toBe("screenshot");
	});

	it("all non-cursor actions return screenshot", async () => {
		const ops = makeMockOps();
		const actions: ComputerToolInput[] = [
			{ action: "key", text: "ctrl+c" },
			{ action: "type", text: "abc" },
			{ action: "left_click" },
		];
		for (const action of actions) {
			const result = await executeComputerAction(action, ops);
			expect(result.content[0]?.type).toBe("image");
		}
	});

	it("error from ops propagates as isError", async () => {
		const ops = makeMockOps();
		ops.type = vi.fn(async () => {
			throw new Error("boom");
		});
		const result = await executeComputerAction({ action: "type", text: "x" }, ops);
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "boom" });
	});

	it("enabled false when env unset", () => {
		expect(isAnthropicComputerUseEnabled()).toBe(false);
	});

	it("enabled false when dims missing", () => {
		process.env[ENV_ENABLE] = "true";
		expect(isAnthropicComputerUseEnabled()).toBe(false);
	});

	it("enabled true when vars are valid", () => {
		setEnabled();
		expect(isAnthropicComputerUseEnabled()).toBe(true);
	});

	it("truthy and falsy env handling", () => {
		for (const value of ["1", "true", "yes", "on", " TRUE "]) {
			setEnabled("1", "1", value);
			expect(isAnthropicComputerUseEnabled()).toBe(true);
		}
		for (const value of ["0", "false", "no", "off", ""]) {
			setEnabled("1", "1", value);
			expect(isAnthropicComputerUseEnabled()).toBe(false);
		}
	});

	it("unsupported ops methods throw clear message", async () => {
		const unsupported = createUnsupportedOps();
		await expect(unsupported.screenshot()).rejects.toThrow("Computer use not supported on Windows");
		await expect(unsupported.cursorPosition()).rejects.toThrow("Computer use not supported on Windows");
		await expect(unsupported.mouseMove(1, 2)).rejects.toThrow("Computer use not supported on Windows");
		await expect(unsupported.click("left")).rejects.toThrow("Computer use not supported on Windows");
	});

	it("injects anthropic beta header and extra_body betas", () => {
		setEnabled();
		const result = addAnthropicComputerUseToPayload("anthropic-messages", { tools: [] }) as Record<string, unknown>;
		expect((result.headers as Record<string, unknown>)["anthropic-beta"]).toContain("computer-use-2025-01-24");
		expect((result.extra_body as Record<string, unknown>).betas).toContain("computer-use-2025-01-24");
	});

	it("preserves existing beta values", () => {
		setEnabled();
		const result = addAnthropicComputerUseToPayload("anthropic-messages", {
			tools: [],
			headers: { "anthropic-beta": "foo" },
			extra_body: { betas: ["bar"] },
		}) as Record<string, unknown>;
		expect((result.headers as Record<string, unknown>)["anthropic-beta"]).toBe("foo,computer-use-2025-01-24");
		expect((result.extra_body as Record<string, unknown>).betas).toEqual(["bar", "computer-use-2025-01-24"]);
	});
});
