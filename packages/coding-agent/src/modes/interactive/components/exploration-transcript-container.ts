import { type Component, Container, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "./assistant-message.ts";
import { CustomEntryComponent } from "./custom-entry.ts";
import { explorationCall } from "./exploration-call.ts";
import { ExplorationGroup } from "./exploration-group.ts";
import { projectRulesOfCall } from "./exploration-rules.ts";
import {
	ProgressiveTranscriptContainer,
	type ProgressiveTranscriptOptions,
} from "./progressive-transcript-container.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";

/**
 * Original children remain the lifecycle/ID/anchor model. A non-owning projection groups their
 * presentation before progressive hydration, so compact frames never render hidden tool results.
 * Re-projecting also handles partial args, late text, and visibility changes without moving cards.
 */
export class ExplorationTranscriptContainer extends Container {
	private readonly display: ProgressiveTranscriptContainer;
	private groups = new WeakMap<ToolExecutionComponent, ExplorationGroup>();

	constructor(options: ProgressiveTranscriptOptions) {
		super();
		this.display = new ProgressiveTranscriptContainer(options);
	}

	override render(width: number): string[] {
		const projected: Component[] = [];
		let group: ExplorationGroup | undefined;
		let members: Component[] = [];
		let calls: ExplorationGroup["calls"] = [];
		let rules: string[] = [];
		for (const child of this.children) {
			const call = child instanceof ToolExecutionComponent ? explorationCall(child) : undefined;
			if (child instanceof ToolExecutionComponent && call) {
				if (!group) {
					group = this.groups.get(child) ?? new ExplorationGroup();
					this.groups.set(child, group);
					projected.push(group);
					members = [];
					calls = [];
					rules = [];
				}
				members.push(child);
				calls.push({ component: child, call });
				group.setMembers(members, calls, rules);
			} else if (group && child instanceof AssistantMessageComponent && child.isExplorationDetail) {
				members.push(child);
			} else if (group && child instanceof CustomEntryComponent && projectRulesOfCall(child, calls)) {
				members.push(child);
				rules = [...rules, ...(projectRulesOfCall(child, calls) ?? [])];
				group.setMembers(members, calls, rules);
			} else {
				group = undefined;
				projected.push(child);
			}
		}
		this.display.children = projected;
		return this.display.render(width);
	}

	override handleMouse(event: TuiMouseEvent) {
		return this.display.handleMouse(event);
	}

	override clear(): void {
		this.display.detachAll();
		this.groups = new WeakMap();
		super.clear();
	}

	override detachAll(): void {
		this.display.detachAll();
		this.groups = new WeakMap();
		super.detachAll();
	}

	override dispose(): void {
		this.display.detachAll();
		this.display.dispose();
		super.dispose();
	}
}
