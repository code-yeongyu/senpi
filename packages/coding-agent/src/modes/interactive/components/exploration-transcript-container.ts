import { type Component, Container, type ScrollEntrySource, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "./assistant-message.ts";
import { CustomEntryComponent } from "./custom-entry.ts";
import { CustomMessageComponent } from "./custom-message.ts";
import { explorationCall } from "./exploration-call.ts";
import { ExplorationGroup } from "./exploration-group.ts";
import { projectRulesOfCall } from "./exploration-rules.ts";
import {
	ProgressiveTranscriptContainer,
	type ProgressiveTranscriptOptions,
} from "./progressive-transcript-container.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";
import { UserMessageComponent } from "./user-message.ts";

/**
 * Original children remain the lifecycle/ID/anchor model. A non-owning projection groups their
 * presentation before progressive hydration, so compact frames never render hidden tool results.
 * Re-projecting also handles partial args, late text, and visibility changes without moving cards.
 */
export class ExplorationTranscriptContainer extends Container {
	private readonly display: ProgressiveTranscriptContainer;
	private groups = new WeakMap<ToolExecutionComponent, ExplorationGroup>();
	private readonly projected: Component[] = [];
	private readonly sourceSnapshot: Component[] = [];
	private readonly sourceIndices = new Map<Component, number>();
	private readonly sourceProjectionIndices: number[] = [];
	private readonly projectionSourceStarts: number[] = [];
	private projectionDirtyFrom = 0;
	private contentRevision = 0;
	private displayRevision = 0;
	private readonly entryRevisions = new WeakMap<Component, number>();
	private readonly changes: { version: number; sourceIndex: number }[] = [];
	private readonly customCards = new Set<CustomEntryComponent | CustomMessageComponent>();

	constructor(options: ProgressiveTranscriptOptions) {
		super();
		this.display = new ProgressiveTranscriptContainer(options);
	}

	override render(width: number): string[] {
		this.updateProjection();
		return this.display.render(width);
	}

	requestFullRender(): void {
		this.display.requestFullRender();
	}

	/** Explicit array-splice callers report their earliest changed source index. */
	markProjectionDirty(index = 0): void {
		let changedFrom = this.sourceStart(index);
		const previousProjection = this.sourceProjectionIndices[Math.max(0, index - 1)];
		if (this.projected[previousProjection] instanceof ExplorationGroup)
			changedFrom = Math.min(changedFrom, this.projectionSourceStarts[previousProjection]);
		this.recordChange(changedFrom);
		this.projectionDirtyFrom = Math.min(this.projectionDirtyFrom, Math.max(0, index));
	}

	get revision(): number {
		return this.contentRevision;
	}

	/** Header/resource containers are unversioned entries with explicit structural notifications. */
	markScrollEntryPrefixChanged(): void {
		this.recordChange(-1);
	}

	/** A non-owning index over the existing projection; reading it never renders or warms history. */
	createScrollEntrySource(prefix: readonly Component[] = []): ScrollEntrySource {
		const transcript = this;
		const leading = [...prefix];
		return {
			get version() {
				transcript.updateProjection();
				return transcript.contentRevision;
			},
			get displayRevision() {
				return transcript.displayRevision;
			},
			get length() {
				transcript.updateProjection();
				return leading.length + transcript.projected.length;
			},
			get(index) {
				transcript.updateProjection();
				if (!Number.isInteger(index) || index < 0 || index >= leading.length + transcript.projected.length)
					throw new RangeError(`Transcript entry index out of range: ${index}`);
				if (index < leading.length) return { key: leading[index], component: leading[index], sourceIndex: index };
				const projectedIndex = index - leading.length;
				const component = transcript.projected[projectedIndex];
				const sourceIndex = transcript.projectionSourceStarts[projectedIndex];
				const key = transcript.children[sourceIndex];
				return {
					key,
					component,
					sourceIndex: sourceIndex + leading.length,
					// Groups animate from the clock; other cards can mutate without notifying this owner.
					revision:
						component instanceof AssistantMessageComponent || component instanceof ToolExecutionComponent
							? transcript.entryRevisions.get(component)
							: undefined,
					...(component instanceof UserMessageComponent ? { prompt: true } : {}),
				};
			},
			indexOf(key) {
				transcript.updateProjection();
				const leadingIndex = leading.indexOf(key as Component);
				if (leadingIndex >= 0) return leadingIndex;
				const sourceIndex = transcript.sourceIndices.get(key as Component);
				return sourceIndex === undefined
					? undefined
					: leading.length + transcript.sourceProjectionIndices[sourceIndex];
			},
			resolve(key, sourceIndexHint) {
				const existing = this.indexOf(key);
				if (existing !== undefined) return existing;
				if (sourceIndexHint < leading.length) return Math.max(0, sourceIndexHint);
				const sourceIndex = Math.min(transcript.children.length - 1, Math.max(0, sourceIndexHint - leading.length));
				if (sourceIndex >= 0) return leading.length + transcript.sourceProjectionIndices[sourceIndex];
				return leading.length > 0 ? leading.length - 1 : undefined;
			},
			changedSince(version) {
				transcript.updateProjection();
				const current = transcript.contentRevision;
				if (!Number.isInteger(version) || version < 0 || version > current) return undefined;
				if (version === current) return Number.POSITIVE_INFINITY;
				const oldest = transcript.changes[0];
				if (!oldest || version < oldest.version - 1) return undefined;
				let earliest = Number.POSITIVE_INFINITY;
				for (const change of transcript.changes) {
					if (change.version > version)
						earliest = Math.min(earliest, change.sourceIndex < 0 ? 0 : change.sourceIndex + leading.length);
				}
				return earliest;
			},
		};
	}

	private sourceStart(index: number): number {
		const projectionIndex = this.sourceProjectionIndices[index];
		return this.projectionSourceStarts[projectionIndex] ?? Math.max(0, index);
	}

	private recordChange(sourceIndex: number): void {
		this.contentRevision += 1;
		this.changes.push({ version: this.contentRevision, sourceIndex });
		// ponytail: bounded selection history; older readers cancel conservatively after 64 mutations.
		if (this.changes.length > 64) this.changes.shift();
	}

	commitCustomRenderedFrames(): void {
		for (const card of this.customCards) card.commitRenderedFrame();
	}

	checkCustomRenderChanges(): void {
		// A source change already requires canonical rendering; do not probe detached cards.
		if (this.projectionDirtyFrom !== Number.POSITIVE_INFINITY) return;
		for (const card of this.customCards) {
			if (card.hasCustomRenderChanged()) {
				this.recordChange(this.sourceStart(this.sourceIndices.get(card) ?? 0));
				break;
			}
		}
	}

	get isFullyHydrated(): boolean {
		return this.display.isFullyHydrated;
	}

	override addChild(component: Component): void {
		this.markProjectionDirty(this.children.length);
		super.addChild(component);
	}

	override removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index >= 0) this.markProjectionDirty(index);
		super.removeChild(component);
	}

	override detachChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index >= 0) this.markProjectionDirty(index);
		super.detachChild(component);
	}

	private observe(component: Component, index: number): void {
		this.sourceIndices.set(component, index);
		if (component instanceof AssistantMessageComponent || component instanceof ToolExecutionComponent) {
			if (!this.entryRevisions.has(component)) this.entryRevisions.set(component, 0);
			component.setTranscriptChangedListener((projectionChanged) => {
				this.entryRevisions.set(component, (this.entryRevisions.get(component) ?? 0) + 1);
				const sourceIndex = this.sourceIndices.get(component) ?? 0;
				if (projectionChanged) this.markProjectionDirty(sourceIndex);
				else this.recordChange(this.sourceStart(sourceIndex));
			});
		}
	}

	private forget(component: Component): void {
		this.sourceIndices.delete(component);
		if (component instanceof CustomEntryComponent || component instanceof CustomMessageComponent)
			this.customCards.delete(component);
		if (component instanceof AssistantMessageComponent || component instanceof ToolExecutionComponent) {
			component.setTranscriptChangedListener(undefined);
		}
	}

	private updateProjection(): void {
		if (
			this.children.length !== this.sourceSnapshot.length &&
			this.projectionDirtyFrom === Number.POSITIVE_INFINITY
		) {
			this.markProjectionDirty(Math.min(this.children.length, this.sourceSnapshot.length));
		}
		if (this.projectionDirtyFrom === Number.POSITIVE_INFINITY) return;
		// Rebuild the affected group from its first member. Appends may continue the
		// previous group, while every earlier projected component remains untouched.
		const changed = Math.max(0, Math.min(this.projectionDirtyFrom, this.sourceSnapshot.length) - 1);
		const projectionIndex = this.sourceProjectionIndices[changed] ?? 0;
		const sourceStart = this.projectionSourceStarts[projectionIndex] ?? 0;
		const previousSources = this.sourceSnapshot.splice(sourceStart);
		for (const component of previousSources) this.forget(component);
		this.sourceProjectionIndices.length = sourceStart;
		this.projected.length = projectionIndex;
		this.projectionSourceStarts.length = projectionIndex;
		let group: ExplorationGroup | undefined;
		let members: Component[] = [];
		let calls: ExplorationGroup["calls"] = [];
		let rules: string[] = [];
		const finishGroup = () => group?.setMembers(members, calls, rules);
		for (let index = sourceStart; index < this.children.length; index++) {
			const child = this.children[index];
			this.observe(child, index);
			this.sourceSnapshot.push(child);
			const call = child instanceof ToolExecutionComponent ? explorationCall(child) : undefined;
			if (child instanceof ToolExecutionComponent && call) {
				if (!group) {
					group = this.groups.get(child) ?? new ExplorationGroup();
					this.groups.set(child, group);
					this.projected.push(group);
					this.projectionSourceStarts.push(index);
					members = [];
					calls = [];
					rules = [];
				}
				members.push(child);
				calls.push({ component: child, call });
			} else if (group && child instanceof AssistantMessageComponent && child.isExplorationDetail) {
				members.push(child);
			} else if (group && child instanceof CustomEntryComponent && projectRulesOfCall(child, calls)) {
				members.push(child);
				rules = [...rules, ...(projectRulesOfCall(child, calls) ?? [])];
			} else {
				finishGroup();
				group = undefined;
				this.projected.push(child);
				this.projectionSourceStarts.push(index);
				if (child instanceof CustomEntryComponent || child instanceof CustomMessageComponent)
					this.customCards.add(child);
			}
			this.sourceProjectionIndices.push(this.projected.length - 1);
		}
		finishGroup();
		for (const component of previousSources) {
			if (!this.sourceIndices.has(component))
				this.entryRevisions.set(component, (this.entryRevisions.get(component) ?? 0) + 1);
		}
		this.display.children = this.projected;
		this.projectionDirtyFrom = Number.POSITIVE_INFINITY;
	}

	private resetProjection(): void {
		this.recordChange(0);
		for (const child of this.sourceSnapshot) {
			this.entryRevisions.set(child, (this.entryRevisions.get(child) ?? 0) + 1);
			this.forget(child);
		}
		this.sourceSnapshot.length = 0;
		this.projected.length = 0;
		this.sourceProjectionIndices.length = 0;
		this.projectionSourceStarts.length = 0;
		this.projectionDirtyFrom = 0;
	}

	override handleMouse(event: TuiMouseEvent) {
		return this.display.handleMouse(event);
	}

	override invalidate(): void {
		this.displayRevision += 1;
		this.recordChange(-1);
		this.projectionDirtyFrom = 0;
		super.invalidate();
	}

	override clear(): void {
		this.resetProjection();
		this.display.detachAll();
		this.groups = new WeakMap();
		super.clear();
	}

	override detachAll(): void {
		this.resetProjection();
		this.display.detachAll();
		this.groups = new WeakMap();
		super.detachAll();
	}

	override dispose(): void {
		this.resetProjection();
		this.display.detachAll();
		this.display.dispose();
		super.dispose();
	}
}
