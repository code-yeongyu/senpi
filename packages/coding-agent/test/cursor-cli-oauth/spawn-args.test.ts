import { describe, expect, it } from "vitest";
import { buildCursorCliArgs } from "../../src/core/extensions/builtin/cursor-cli-oauth/spawn-args.ts";

describe("buildCursorCliArgs", () => {
	it("builds a fresh print-mode invocation in byte-exact order", () => {
		expect(
			buildCursorCliArgs({
				prompt: "Implement the requested change",
				model: "cursor-large",
				force: true,
				executionMode: "agent",
			}),
		).toEqual([
			"-p",
			"Implement the requested change",
			"--output-format",
			"stream-json",
			"--stream-partial-output",
			"--trust",
			"--model",
			"cursor-large",
			"--force",
		]);
	});

	it("adds a resume chat id after the model", () => {
		expect(
			buildCursorCliArgs({
				prompt: "Continue",
				model: "cursor-small",
				resumeChatId: "chat-123",
				force: true,
			}),
		).toEqual([
			"-p",
			"Continue",
			"--output-format",
			"stream-json",
			"--stream-partial-output",
			"--trust",
			"--model",
			"cursor-small",
			"--resume",
			"chat-123",
			"--force",
		]);
	});

	it("serializes plan mode without deciding force policy", () => {
		expect(
			buildCursorCliArgs({
				prompt: "Draft a plan",
				force: true,
				executionMode: "plan",
			}),
		).toEqual([
			"-p",
			"Draft a plan",
			"--output-format",
			"stream-json",
			"--stream-partial-output",
			"--trust",
			"--force",
			"--mode",
			"plan",
		]);
	});

	it("omits force when it is false", () => {
		expect(buildCursorCliArgs({ prompt: "Ask first", force: false, executionMode: "agent" })).toEqual([
			"-p",
			"Ask first",
			"--output-format",
			"stream-json",
			"--stream-partial-output",
			"--trust",
		]);
	});

	it("appends a sandbox mode last", () => {
		expect(
			buildCursorCliArgs({
				prompt: "Run safely",
				model: "cursor-large",
				resumeChatId: "chat-456",
				force: true,
				executionMode: "plan",
				sandboxMode: "workspace-write",
			}),
		).toEqual([
			"-p",
			"Run safely",
			"--output-format",
			"stream-json",
			"--stream-partial-output",
			"--trust",
			"--model",
			"cursor-large",
			"--resume",
			"chat-456",
			"--force",
			"--mode",
			"plan",
			"--sandbox",
			"workspace-write",
		]);
	});

	it("keeps shell syntax and flag-like text in one prompt argv element", () => {
		const prompt = "Review this; echo $(whoami) --force --resume stolen-chat";
		const args = buildCursorCliArgs({ prompt });

		expect(args).toEqual(["-p", prompt, "--output-format", "stream-json", "--stream-partial-output", "--trust"]);
		expect(args[1]).toBe(prompt);
		expect(args).not.toContain("--force");
		expect(args).not.toContain("--resume");
	});

	it.each(["", "line one\nline two", "before\u0000after", "low\u0001high\u007f"])(
		"preserves an adversarial prompt byte-for-byte: %j",
		(prompt) => {
			const args = buildCursorCliArgs({ prompt, model: undefined });

			expect(args).toEqual(["-p", prompt, "--output-format", "stream-json", "--stream-partial-output", "--trust"]);
			expect(args[1]).toBe(prompt);
		},
	);

	it("never emits auth, environment, or yolo flags", () => {
		const args = buildCursorCliArgs({
			prompt: "Authenticate normally",
			model: "cursor-large",
			resumeChatId: "chat-789",
			force: true,
			executionMode: "plan",
			sandboxMode: "workspace-write",
		});

		expect(args).not.toContain("--api-key");
		expect(args).not.toContain("--yolo");
		expect(args.some((arg) => /(?:api[_-]?key|env)/i.test(arg))).toBe(false);
	});
});
