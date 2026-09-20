import { type Component, Container, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { type ExplorationCall, requestedRanges } from "./exploration-call.ts";
import { keyText } from "./keybinding-hints.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

/** Non-owning view of original cards. The transcript alone disposes these components. */
export class ExplorationGroup extends Container {
	calls: { readonly component: ToolExecutionComponent; readonly call: ExplorationCall }[] = [];

	private get expanded(): boolean {
		return this.calls.some(({ component }) => component.presentationSnapshot.state.expanded);
	}

	override render(width: number): string[] {
		const pending = this.calls.some(({ call }) => call.pending);
		const failed = this.calls.filter(({ call }) => call.failed).length;
		const hint = `${keyText("app.tools.expand")} to ${this.expanded ? "collapse" : "expand"}`;
		const header =
			theme.bold(theme.fg("toolTitle", pending ? "Exploring" : "Explored")) +
			theme.fg("muted", ` (${this.calls.length} calls, ${hint})`) +
			(failed ? theme.fg("error", ` · ${failed} failed`) : "");
		const lines = ["", truncateToWidth(header, width)];
		if (this.expanded) return [...lines, ...super.render(width)];
		let rows = 0;
		for (let index = 0; index < this.calls.length; ) {
			const first = this.calls[index].call;
			const run = [first];
			index++;
			if (first.action === "Read" && !first.failed) {
				while (index < this.calls.length) {
					const next = this.calls[index].call;
					if (next.action !== "Read" || next.failed || next.pathKey !== first.pathKey) break;
					run.push(next);
					index++;
				}
			}
			if (rows < 3) {
				const ranges = run.flatMap((call) => (call.range ? [call.range] : []));
				const count = `${run.length} ${run.length === 1 ? "read" : "reads"}`;
				const detail =
					first.action === "Read"
						? `${first.path} (${count}; requested ${requestedRanges(ranges)})`
						: `${first.query ? `${first.query} in ` : ""}${first.path}`;
				const status = first.failed ? " [failed]" : run.some((call) => call.truncated) ? " [truncated]" : "";
				lines.push(
					truncateToWidth(
						`  ${theme.fg("accent", first.action)} ${detail}${theme.fg(first.failed ? "error" : "warning", status)}`,
						width,
					),
				);
			}
			rows++;
		}
		if (rows > 3)
			lines.push(truncateToWidth(theme.fg("muted", `  ... ${rows - 3} more activities (${hint})`), width));
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
