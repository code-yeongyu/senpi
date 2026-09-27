import {
	isMouseSequence,
	MOUSE_TRACKING,
	MouseClickSynthesizer,
	parseSgrMouseEvent,
	toTuiMouseEvent,
} from "./mouse-input.ts";
import { isImageLine } from "./terminal-image.ts";
import {
	type Component,
	Container,
	dispatchMouseEvent,
	retargetMouseEvent,
	TuiBase,
	type TuiMouseDispatchResult,
	type TuiMouseDispatchTarget,
	type TuiMouseEvent,
} from "./tui.ts";

export interface TuiMainScreenRenderState {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
}

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase {
	readonly mode = "regular" as const;
	private trackingEnabled = false;
	private readonly clicks = new MouseClickSynthesizer();
	private mousePress?: { target: TuiMouseDispatchTarget; epoch: number; revision: number; x: number; y: number };
	private layoutRevision = 0;
	private committedMouseLines: string[] = [];
	private committedMouseComponents: Component[] = [];

	constructor(...args: ConstructorParameters<typeof TuiBase>) {
		super(...args);
		this.addInputListener((data) => this.handleMouseInput(data));
	}

	protected override applyMouseTracking(enabled: boolean): void {
		const supported =
			Boolean(process.stdout.isTTY) &&
			!process.env.TERMUX_VERSION &&
			(process.platform !== "win32" || Boolean(process.env.WT_SESSION));
		const next = enabled && supported && !this.stopped;
		this.clicks.cancel();
		this.mousePress = undefined;
		if (this.trackingEnabled === next) return;
		this.trackingEnabled = next;
		this.terminal.write(next ? MOUSE_TRACKING.inline : MOUSE_TRACKING.disable);
		if (next) {
			// Capture can be acquired after many frames rendered without a mouse lease.
			// Keep the existing identity snapshot: the live tree may have uncommitted changes.
			this.noteCommittedMouseFrame();
		}
	}

	protected override beforeTerminalStop(): void {
		this.terminal.write(MOUSE_TRACKING.disable);
		this.trackingEnabled = false;
		this.clicks.cancel();
		this.mousePress = undefined;
	}

	protected override doRender(): void {
		if (this.stopped) return;
		if (this.mouseExternalWritePending) {
			// CPR locates the cursor, not an old frame displaced by arbitrary output.
			// Append a new working frame without erasing diagnostics or scrollback.
			this.mouseExternalWritePending = false;
			this.terminal.write("\r\n");
			this.restoreRenderState({
				previousLines: [],
				previousWidth: 0,
				previousHeight: 0,
				cursorRow: 0,
				hardwareCursorRow: 0,
				maxLinesRendered: 0,
				previousViewportTop: 0,
			});
		}
		super.doRender();
		if (this.trackingEnabled) this.noteCommittedMouseFrame();
		this.updateMouseLayoutRevision();
		if (this.trackingEnabled) this.calibrateMouseAnchor();
	}

	private updateMouseLayoutRevision(): void {
		const components: Component[] = [];
		const visit = (component: Component): void => {
			components.push(component);
			if (component instanceof Container) for (const child of component.children) visit(child);
		};
		// Native history has no active mouse capture or canonical component coordinates.
		// Preserve the cheap native path without walking the historical component tree.
		if (!this.nativeWorkingRegionActive) for (const root of this.getMouseLayoutRoots()) visit(root);
		if (
			this.trackingEnabled &&
			(this.previousLines.length !== this.committedMouseLines.length ||
				this.previousLines.some((line, index) => line !== this.committedMouseLines[index]) ||
				components.length !== this.committedMouseComponents.length ||
				components.some((component, index) => component !== this.committedMouseComponents[index]))
		) {
			this.layoutRevision++;
		}
		// Committed line arrays are replaced, never mutated, so no full-history copy is needed.
		this.committedMouseLines = this.previousLines;
		this.committedMouseComponents = components;
	}

	private applyMouseResult(result: TuiMouseDispatchResult | undefined): void {
		if (!result?.focus) return;
		const target = this.resolveMouseFocusTarget(result.focusTarget ?? result.target.component);
		if (target) this.setFocus(target);
	}

	private handleMouseInput(data: string): { consume: boolean } {
		if (!isMouseSequence(data)) return { consume: false };
		const raw = parseSgrMouseEvent(data);
		if (!this.trackingEnabled || !raw || raw.button !== 0) {
			this.clicks.cancel();
			this.mousePress = undefined;
			return { consume: true };
		}
		const frameLine = this.resolveFrameLine(raw.y + 1);
		if (frameLine === undefined || raw.x >= this.terminal.columns) {
			this.clicks.cancel();
			this.mousePress = undefined;
			return { consume: true };
		}
		const event = toTuiMouseEvent(raw.release ? "release" : "press", raw, this.terminal);
		if (!raw.release) {
			const overlay = this.dispatchMouseToOverlay(event);
			const result =
				overlay.result ??
				(overlay.hit
					? undefined
					: dispatchMouseEvent(this, { ...event, y: frameLine, height: this.previousLines.length }));
			this.mousePress = undefined;
			if (result) {
				this.applyMouseResult(result);
				this.mousePress = {
					target: result.target,
					epoch: this.placementEpoch,
					revision: this.layoutRevision,
					x: raw.x,
					y: raw.y,
				};
				this.clicks.press(raw, result.target.component, this.placementEpoch);
			} else this.clicks.cancel();
			this.requestRender();
		} else {
			const press = this.mousePress;
			this.mousePress = undefined;
			if (
				!press ||
				press.epoch !== this.placementEpoch ||
				press.revision !== this.layoutRevision ||
				press.x !== raw.x ||
				press.y !== raw.y
			) {
				this.clicks.cancel();
				return { consume: true };
			}
			const count = this.clicks.release(raw, press.target.component, this.placementEpoch);
			if (count !== undefined) {
				const click: TuiMouseEvent = { ...event, type: "click", clickCount: count };
				// A click handler that moves focus (an ask-user submit restoring the composer) owns the
				// outcome; re-applying the click target afterwards would steal focus back from it.
				const focusBeforeClick = this.getFocusedComponent();
				const clickResult = dispatchMouseEvent(press.target.component, retargetMouseEvent(click, press.target));
				if (this.getFocusedComponent() === focusBeforeClick) this.applyMouseResult(clickResult);
				this.requestRender();
			}
		}
		return { consume: true };
	}

	captureRenderState(): TuiMainScreenRenderState {
		return {
			previousLines: [...this.previousLines],
			previousWidth: this.previousWidth,
			previousHeight: this.previousHeight,
			cursorRow: this.cursorRow,
			hardwareCursorRow: this.hardwareCursorRow,
			maxLinesRendered: this.maxLinesRendered,
			previousViewportTop: this.previousViewportTop,
		};
	}

	restoreRenderState(state: TuiMainScreenRenderState): void {
		this.cancelResizeViewport();
		this.setPreviousLines(
			state.previousLines.map((line) => (isImageLine(line) ? "" : line)),
			[],
		);
		this.previousKittyImageIds = new Set();
		this.previousWidth = state.previousWidth;
		this.previousHeight = state.previousHeight;
		this.cursorRow = state.cursorRow;
		this.hardwareCursorRow = state.hardwareCursorRow;
		this.maxLinesRendered = state.maxLinesRendered;
		this.previousViewportTop = state.previousViewportTop;
	}
}
