import { describe, expect, it } from "vitest";

import { renderWebfetchResult } from "../src/core/extensions/builtin/webfetch/webfetch/renderers.ts";
import type { WebfetchProgressDetails } from "../src/core/extensions/builtin/webfetch/webfetch/tool.ts";
import type { Theme, ThemeColor } from "../src/modes/interactive/theme/theme.ts";

const passthroughTheme = {
	bold: (value: string) => value,
	fg: (_key: ThemeColor, value: string) => value,
} as unknown as Theme;

function progress(
	phase: WebfetchProgressDetails["phase"],
	details: Partial<WebfetchProgressDetails> = {},
): WebfetchProgressDetails {
	return {
		phase,
		url: "https://example.com/large-page",
		format: "markdown",
		timeoutSeconds: 30,
		progress: {
			activity: "fetching https://example.com/large-page",
			startedAt: 0,
			maxWaitMs: 30_000,
		},
		...details,
	};
}

function renderProgress(details: WebfetchProgressDetails): string {
	return renderWebfetchResult({ content: [], details }, { expanded: false, isPartial: true }, passthroughTheme)
		.render(200)
		.join("\n")
		.trimEnd();
}

describe("webfetch progress renderer", () => {
	it("renders fetching, humanized download bytes, and converting phases", () => {
		expect(renderProgress(progress("fetching"))).toBe("Fetching https://example.com/large-page as markdown (30s)");
		expect(renderProgress(progress("downloading", { bytesRead: 12_595 }))).toBe(
			"Downloading https://example.com/large-page: 12.3 KB",
		);
		expect(renderProgress(progress("downloading", { bytesRead: 12_595, totalBytes: 1_258_291 }))).toBe(
			"Downloading https://example.com/large-page: 12.3 KB / 1.2 MB",
		);
		expect(renderProgress(progress("converting"))).toBe("Converting https://example.com/large-page to markdown");
	});
});
