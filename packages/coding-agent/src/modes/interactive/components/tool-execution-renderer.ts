import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Box, type Component, Container, getCapabilities, Text } from "@earendil-works/pi-tui";
import type { ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolDef, type ToolName } from "../../../core/tools/index.ts";
import { theme } from "../theme/theme.ts";
import { formatToolProgressLine, readToolProgress } from "../tool-progress.ts";
import {
	createToolCallFallback,
	createToolResultFallback,
	formatToolExecutionFallback,
} from "./tool-execution-fallback.ts";
import type { ToolExecutionIdentity, ToolExecutionRenderState, ToolExecutionResult } from "./tool-execution-types.ts";
import { isComponent, ToolRendererBoundary } from "./tool-renderer-boundary.ts";

type RenderContainer = Box | Container;
type RendererSlot = "call" | "result";

export class ToolExecutionRenderer extends Container {
	private readonly identity: ToolExecutionIdentity;
	private readonly builtInDefinition: ToolDef | undefined;
	private readonly contentBox: Box;
	private readonly contentText: Text;
	private readonly selfRenderContainer = new Container();
	private readonly rendererState: Record<string, unknown> = {};
	private readonly disposedRendererComponents = new WeakSet<Component>();
	private readonly onInvalidate: () => void;
	private state: ToolExecutionRenderState;
	private suspended = false;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;

	constructor(identity: ToolExecutionIdentity, state: ToolExecutionRenderState, onInvalidate: () => void) {
		super();
		this.identity = identity;
		this.state = state;
		this.onInvalidate = onInvalidate;
		this.builtInDefinition = identity.trustedBuiltIn
			? createAllToolDefinitions(identity.cwd)[identity.toolName as ToolName]
			: undefined;
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.addChild(
			this.hasRendererDefinition
				? this.renderShell === "self"
					? this.selfRenderContainer
					: this.contentBox
				: this.contentText,
		);
	}

	get hasRendererDefinition(): boolean {
		return this.builtInDefinition !== undefined || this.identity.toolDefinition !== undefined;
	}

	get hasResultRenderer(): boolean {
		return this.getResultRenderer() !== undefined;
	}

	get renderShell(): "default" | "self" {
		const customShell = this.identity.toolDefinition?.renderShell;
		return customShell ?? this.builtInDefinition?.renderShell ?? "default";
	}

	update(state: ToolExecutionRenderState): void {
		this.suspended = false;
		this.state = state;
		const background = state.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: state.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		const progress = state.isPartial ? readToolProgress(state.result?.details) : undefined;
		if (!this.hasRendererDefinition) {
			this.contentText.setCustomBgFn(background);
			let text = formatToolExecutionFallback(this.identity.toolName, state.args, state.result, state.showImages);
			if (progress) text += `\n${formatToolProgressLine(progress, Date.now(), state.spinnerFrame)}`;
			this.contentText.setText(text);
			return;
		}

		const container = this.renderShell === "self" ? this.selfRenderContainer : this.contentBox;
		if (container instanceof Box) container.setBgFn(background);
		container.detachAll();
		this.renderCall(container);
		if (state.result) this.renderResult(container, state.result);
		if (progress)
			container.addChild(new Text(formatToolProgressLine(progress, Date.now(), state.spinnerFrame), 0, 0));
	}

	suspend(): void {
		if (this.suspended) return;
		this.suspended = true;
		const components = new Set([this.callRendererComponent, this.resultRendererComponent]);
		this.callRendererComponent = undefined;
		this.resultRendererComponent = undefined;
		this.selfRenderContainer.detachAll();
		this.contentBox.detachAll();
		this.disposeRenderState(this.identity.toolDefinition);
		if (this.builtInDefinition !== this.identity.toolDefinition) {
			this.disposeRenderState(this.builtInDefinition);
		}
		for (const component of components) this.disposeRendererComponent(component);
	}

	override dispose(): void {
		this.suspend();
		super.dispose();
	}

	private getCallRenderer(): ToolDef["renderCall"] | undefined {
		return this.identity.toolDefinition?.renderCall ?? this.builtInDefinition?.renderCall;
	}

	private getResultRenderer(): ToolDef["renderResult"] | undefined {
		return this.identity.toolDefinition?.renderResult ?? this.builtInDefinition?.renderResult;
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext<Record<string, unknown>, unknown> {
		return {
			args: this.state.args,
			toolCallId: this.identity.toolCallId,
			invalidate: this.onInvalidate,
			lastComponent,
			state: this.rendererState,
			cwd: this.identity.cwd,
			executionStarted: this.state.executionStarted,
			argsComplete: this.state.argsComplete,
			isPartial: this.state.isPartial,
			expanded: this.state.expanded,
			showImages: this.state.showImages,
			imageProtocol: getCapabilities().images,
			isError: this.state.result?.isError ?? false,
			hasResult: this.state.result !== undefined,
			spinnerFrame: this.state.spinnerFrame,
		};
	}

	private renderCall(container: RenderContainer): void {
		const fallback = createToolCallFallback(this.identity.toolName);
		const renderer = this.getCallRenderer();
		if (!renderer) {
			container.addChild(fallback);
			return;
		}
		try {
			const component = renderer(this.state.args, theme, this.getRenderContext(this.callRendererComponent));
			this.addRendererComponent(container, "call", component, fallback);
		} catch {
			this.setRendererComponent("call", undefined);
			container.addChild(fallback);
		}
	}

	private renderResult(container: RenderContainer, result: ToolExecutionResult): void {
		const fallback = createToolResultFallback(result, this.state.showImages);
		const renderer = this.getResultRenderer();
		if (!renderer) {
			if (fallback) container.addChild(fallback);
			return;
		}
		try {
			const agentResult = { content: result.content, details: result.details } satisfies AgentToolResult<unknown>;
			const component = renderer(
				agentResult,
				{ expanded: this.state.expanded, isPartial: this.state.isPartial },
				theme,
				this.getRenderContext(this.resultRendererComponent),
			);
			this.addRendererComponent(container, "result", component, fallback);
		} catch {
			this.setRendererComponent("result", undefined);
			if (fallback) container.addChild(fallback);
		}
	}

	private addRendererComponent(
		container: RenderContainer,
		slot: RendererSlot,
		value: unknown,
		fallback: Component | undefined,
	): void {
		if (!isComponent(value)) {
			this.setRendererComponent(slot, undefined);
			if (fallback) container.addChild(fallback);
			return;
		}
		this.setRendererComponent(slot, value);
		container.addChild(
			new ToolRendererBoundary(
				value,
				fallback,
				() => {
					if (this.callRendererComponent === value) this.callRendererComponent = undefined;
					if (this.resultRendererComponent === value) this.resultRendererComponent = undefined;
				},
				() => this.disposeRendererComponent(value),
			),
		);
	}

	private getRendererComponent(slot: RendererSlot): Component | undefined {
		return slot === "call" ? this.callRendererComponent : this.resultRendererComponent;
	}

	private setRendererComponent(slot: RendererSlot, component: Component | undefined): void {
		const previous = this.getRendererComponent(slot);
		const other = slot === "call" ? this.resultRendererComponent : this.callRendererComponent;
		if (slot === "call") this.callRendererComponent = component;
		else this.resultRendererComponent = component;
		if (previous && previous !== component && previous !== other) this.disposeRendererComponent(previous);
	}

	private disposeRenderState(definition: ToolDef | undefined): void {
		try {
			definition?.disposeRenderState?.(this.rendererState);
		} catch {}
	}

	private disposeRendererComponent(component: Component | undefined): void {
		if (!component || this.disposedRendererComponents.has(component)) return;
		this.disposedRendererComponents.add(component);
		try {
			const dispose = Reflect.get(component, "dispose");
			if (typeof dispose === "function") Reflect.apply(dispose, component, []);
		} catch {}
	}
}
