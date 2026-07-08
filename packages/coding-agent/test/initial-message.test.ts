import { describe, expect, test } from "vitest";
import type { Args } from "../src/cli/args.ts";
import { buildInitialMessage } from "../src/cli/initial-message.ts";

function createArgs(messages: string[] = []): Args {
	return {
		messages: [...messages],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};
}

describe("buildInitialMessage", () => {
	test("merges piped stdin with the first CLI message into one prompt", () => {
		const parsed = createArgs(["Summarize the text given"]);
		const result = buildInitialMessage({
			parsed,
			stdinContent: "README contents\n",
		});

		expect(result.initialMessage).toBe("README contents\nSummarize the text given");
		expect(result.initialTitlePrompt).toBeUndefined();
		expect(parsed.messages).toEqual([]);
	});

	test("uses stdin as the initial prompt when no CLI message is present", () => {
		const parsed = createArgs();
		const result = buildInitialMessage({
			parsed,
			stdinContent: "README contents",
		});

		expect(result.initialMessage).toBe("README contents");
		expect(result.initialTitlePrompt).toBeUndefined();
		expect(parsed.messages).toEqual([]);
	});

	test("combines stdin, file text, and first CLI message in one prompt", () => {
		const parsed = createArgs(["Explain it", "Second message"]);
		const result = buildInitialMessage({
			parsed,
			stdinContent: "stdin\n",
			fileText: "file\n",
		});

		expect(result.initialMessage).toBe("stdin\nfile\nExplain it");
		expect(result.initialTitlePrompt).toBeUndefined();
		expect(parsed.messages).toEqual(["Second message"]);
	});

	test("uses the first CLI message as the title prompt when no private context is merged", () => {
		const parsed = createArgs(["Explain the architecture"]);
		const result = buildInitialMessage({ parsed });

		expect(result.initialMessage).toBe("Explain the architecture");
		expect(result.initialTitlePrompt).toBe("Explain the architecture");
		expect(parsed.messages).toEqual([]);
	});

	test("does not title from a prompt that includes file text", () => {
		const parsed = createArgs(["Summarize this"]);
		const result = buildInitialMessage({
			parsed,
			fileText: "private file contents\n",
		});

		expect(result.initialMessage).toBe("private file contents\nSummarize this");
		expect(result.initialTitlePrompt).toBeUndefined();
		expect(parsed.messages).toEqual([]);
	});
});
