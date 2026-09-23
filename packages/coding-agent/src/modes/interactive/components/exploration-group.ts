import { type Component, Container, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { toolSpinnerGlyph } from "../tool-progress.ts";
import type { ExplorationCall } from "./exploration-call.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

/** Body lines past this many collapse into one `… +K more` line, as codex caps exploring cells. */
const MAX_BODY_LINES = 8;
const SPINNER_FRAME_MS = 80;

function bodyLines(calls: readonly ExplorationCall[]): string[] {
	const lines: string[] = [];
	for (let index = 0; index < calls.length; ) {
		const first = calls[index];
		index++;
		if (first.action === "Read" && !first.failed) {
			const names = [first.label];
			while (index < calls.length && calls[index].action === "Read" && !calls[index].failed) {
				names.push(calls[index].label);
				index++;
			}
			const unique = [...new Set(names.filter(Boolean))];
			lines.push(`${theme.fg("accent", "Read")} ${unique.join(theme.fg("dim", ", "))}`.trimEnd());
			continue;
		}
		const failed = first.failed ? theme.fg("error", " (failed)") : "";
		lines.push(`${theme.fg("accent", first.action)} ${first.label}`.trimEnd() + failed);
	}
	return lines;
}

/**
 * Codex-style exploring cell over the original tool cards. It is a non-owning view: the transcript
 * owns and disposes the cards, and result routing keeps addressing them by tool call id.
 */
export class ExplorationGroup extends Container {
	calls: { readonly component: ToolExecutionComponent; readonly call: ExplorationCall }[] = [];

	private get expanded(): boolean {
		return this.calls.some(({ component }) => component.presentationSnapshot.state.expanded);
	}

	override render(width: number): string[] {
		const pending = this.calls.some(({ call }) => call.pending);
		const failed = this.calls.filter(({ call }) => call.failed).length;
		const marker = pending
			? theme.fg("accent", toolSpinnerGlyph(Math.floor(Date.now() / SPINNER_FRAME_MS)))
			: theme.fg("dim", "•");
		const header =
			`${marker} ${theme.bold(pending ? "Exploring" : "Explored")}` +
			(failed ? theme.fg("error", ` · ${failed} failed`) : "");
		const lines = ["", truncateToWidth(header, width)];
		if (this.expanded) return [...lines, ...super.render(width)];
		const body = bodyLines(this.calls.map(({ call }) => call));
		const shown = body.length > MAX_BODY_LINES ? body.slice(0, MAX_BODY_LINES) : body;
		if (body.length > shown.length) shown.push(theme.fg("dim", `… +${body.length - shown.length} more`));
		for (const [index, line] of shown.entries()) {
			lines.push(truncateToWidth(`${index === 0 ? theme.fg("dim", "  └ ") : "    "}${line}`, width));
		}
		return lines;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (
			(event.type === "press" || event.type === "click") &&
			event.button === "left" &&
			(event.y === 1 || !this.expanded)
		) {
			if (event.type === "click") {
				const expanded = !this.expanded;
				for (const { component } of this.calls) component.setExpanded(expanded);
			}
			return {
				handled: true,
				target: {
					component: this,
					originX: event.screenX - event.x,
					originY: event.screenY - event.y,
					width: event.width,
					height: event.height,
				},
			};
		}
		if (this.expanded && event.y >= 2)
			return super.handleMouse({ ...event, y: event.y - 2, height: event.height - 2 });
		return undefined;
	}

	/** References are replaced on each projection, never disposed by this view. */
	setMembers(members: Component[], calls: ExplorationGroup["calls"]): void {
		this.children = members;
		this.calls = calls;
	}
}
