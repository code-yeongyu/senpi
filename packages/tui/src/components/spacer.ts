import { type Component, nextRenderRevision } from "../tui.ts";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	private lines: number;
	private revision = nextRenderRevision();

	constructor(lines: number = 1) {
		this.lines = lines;
	}

	setLines(lines: number): void {
		this.lines = lines;
		this.markRevision();
	}

	invalidate(): void {
		this.markRevision();
	}

	/** Instances that expose a revision advance the shared clock; others (e.g. an animated subclass) stay local. */
	private markRevision(): void {
		this.revision = this.getRenderRevision() === undefined ? this.revision + 1 : nextRenderRevision();
	}

	getRenderRevision(): number | undefined {
		return Object.getPrototypeOf(this) === Spacer.prototype ? this.revision : undefined;
	}

	render(_width: number): string[] {
		const result: string[] = [];
		for (let i = 0; i < this.lines; i++) {
			result.push("");
		}
		return result;
	}
}
