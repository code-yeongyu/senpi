import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMessagePathLinkTransformer } from "../../../src/modes/interactive/components/message-path-links.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repository() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-3415-links-")));
	dirs.push(root);
	mkdirSync(join(root, ".git"));
	const cwd = join(root, "packages", "app");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs", "plan.md"), "plan");
	return { root, cwd };
}

const context = { messageType: "assistant" as const, isStreaming: false, availableWidth: 80 };

describe("message path links in the TUI (#3415)", () => {
	it("points a relative link at the file the project root holds", () => {
		const { root, cwd } = repository();
		const transform = createMessagePathLinkTransformer(() => cwd, { hyperlinks: () => true });
		const url = pathToFileURL(join(root, "docs", "plan.md")).href;
		expect(transform("See [the plan](docs/plan.md#goals).", context)).toBe(`See [the plan](${url}#goals).`);
	});

	it("rewrites the other links when one link is badly encoded (#3419 review M1)", () => {
		const { root, cwd } = repository();
		const transform = createMessagePathLinkTransformer(() => cwd, { hyperlinks: () => true });
		const url = pathToFileURL(join(root, "docs", "plan.md")).href;
		expect(transform("[bad](100%) [plan](docs/plan.md)", context)).toBe(`[bad](100%) [plan](${url})`);
	});

	it("checks a missing path once, not on every render (#3419 review M2)", () => {
		const { cwd } = repository();
		const resolve = vi.fn(() => ({ status: "not_found" as const, tried: [] }));
		const transform = createMessagePathLinkTransformer(() => cwd, { hyperlinks: () => true, resolve });
		for (let render = 0; render < 5; render += 1) transform("[gone](docs/missing.md)", context);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it("leaves links alone when the terminal cannot show hyperlinks (#3419 review M3)", () => {
		const { cwd } = repository();
		const transform = createMessagePathLinkTransformer(() => cwd, { hyperlinks: () => false });
		expect(transform("See [the plan](docs/plan.md).", context)).toBe("See [the plan](docs/plan.md).");
	});

	it("skips indented code, mismatched fences and images; keeps link titles (#3419 review M4, L2)", () => {
		const { root, cwd } = repository();
		const transform = createMessagePathLinkTransformer(() => cwd, { hyperlinks: () => true });
		const url = pathToFileURL(join(root, "docs", "plan.md")).href;
		const markdown = [
			"    [indented](docs/plan.md)",
			"~~~",
			"```",
			"[inside](docs/plan.md)",
			"~~~",
			"[after](docs/plan.md)",
			"![img](docs/plan.md)",
			'[titled](docs/plan.md "The plan")',
		].join("\n");
		expect(transform(markdown, context).split("\n")).toEqual([
			"    [indented](docs/plan.md)",
			"~~~",
			"```",
			"[inside](docs/plan.md)",
			"~~~",
			`[after](${url})`,
			"![img](docs/plan.md)",
			`[titled](${url} "The plan")`,
		]);
	});

	it("never touches the file system for a network path (#3419 review H1)", () => {
		const resolve = vi.fn(() => ({ status: "not_found" as const, tried: [] }));
		const transform = createMessagePathLinkTransformer(() => "/work", { hyperlinks: () => true, resolve });
		transform("[x](//attacker/share/x.pdf) [y](\\\\attacker\\share\\y.pdf)", context);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("leaves URLs, anchors, missing files and code alone", () => {
		const { cwd } = repository();
		const transform = createMessagePathLinkTransformer(() => cwd, { hyperlinks: () => true });
		const markdown = [
			"[site](https://example.com) [top](#intro) [gone](docs/missing.md)",
			"`[code](docs/plan.md)`",
			"```",
			"[fenced](docs/plan.md)",
			"```",
		].join("\n");
		expect(transform(markdown, context)).toBe(markdown);
	});
});
