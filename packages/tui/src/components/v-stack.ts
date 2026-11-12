import { copyLineSources, setLineSource } from "../selection-source.ts";
import { allocateStackSizes, Stack, type StackChild, type StackOptions, visibleStackEntries } from "./stack.ts";

export class VStack extends Stack {
	protected readonly layoutType = "vstack" as const;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	override render(width: number): string[] {
		const viewport = { width: Math.max(1, width), height: Number.MAX_SAFE_INTEGER };
		const entries = visibleStackEntries(this.entries, viewport);
		const rendered = entries.map((entry) => entry.component.render(viewport.width));
		const sizes = allocateStackSizes(
			entries,
			rendered.map((lines) => lines.length),
			undefined,
			this.gap,
		);
		const lines: string[] = [];
		for (let index = 0; index < entries.length; index++) {
			if (index > 0) {
				for (let gap = 0; gap < this.gap; gap++) {
					lines.push("");
					setLineSource(lines, lines.length - 1, null);
				}
			}
			const original = rendered[index]!;
			const childLines = copyLineSources(original, original.slice(0, sizes[index]));
			const offset = lines.length;
			lines.push(...childLines);
			copyLineSources(childLines, lines, offset);
			for (let padding = childLines.length; padding < sizes[index]!; padding++) {
				lines.push("");
				setLineSource(lines, lines.length - 1, null);
			}
		}
		return lines;
	}
}

export type { StackChild, StackEntry, StackEntryOptions, StackOptions } from "./stack.ts";
