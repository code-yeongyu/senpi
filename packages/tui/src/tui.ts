/**
 * Minimal TUI implementation with differential rendering
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { isKeyRelease, matchesKey } from "./keys.ts";
import { isMultiplexerSession, useLegacyMuxRender, viewportRenderEnabled } from "./mux.ts";
import type { Terminal } from "./terminal.ts";
import {
	parseOscColorResponse,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
	type TerminalColors,
} from "./terminal-colors.ts";
import {
	deleteKittyImage,
	getCapabilities,
	isImageLine,
	resetCapabilitiesCache,
	setCellDimensions,
} from "./terminal-image.ts";
import { consumeTmuxFocusEvent, DISABLE_FOCUS_REPORTING, ENABLE_FOCUS_REPORTING } from "./tmux-focus.ts";
import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.ts";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";
const MAX_RENDER_WRITE_CHARS = 1024 * 1024;

function writeBounded(terminal: Terminal, data: string): void {
	for (let offset = 0; offset < data.length; offset += MAX_RENDER_WRITE_CHARS) {
		let end = Math.min(data.length, offset + MAX_RENDER_WRITE_CHARS);
		if (
			end < data.length &&
			data.charCodeAt(end - 1) >= 0xd800 &&
			data.charCodeAt(end - 1) <= 0xdbff &&
			data.charCodeAt(end) >= 0xdc00 &&
			data.charCodeAt(end) <= 0xdfff
		)
			end--;
		if (end === offset) end++;
		terminal.write(data.slice(offset, end));
	}
}

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;

	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") ids.push(numberValue);
		else if (key === "r") rows = numberValue;
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

/**
 * Component interface - all components must implement this
 */
export type TuiMouseEventType = "press" | "release" | "move" | "drag" | "click" | "wheel";
export type TuiMouseButton = "left" | "middle" | "right" | "none";

/** Normalized cell-based mouse event. Coordinates are zero-based. */
export interface TuiMouseEvent {
	type: TuiMouseEventType;
	button: TuiMouseButton;
	/** Coordinates local to the receiving component. */
	x: number;
	y: number;
	/** Absolute terminal coordinates. */
	screenX: number;
	screenY: number;
	/** Current component bounds. */
	width: number;
	height: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	/** Logical lines. Negative values scroll up. */
	wheelDelta?: number;
	/** Consecutive click count when type is click. */
	clickCount?: number;
}

export interface TuiMouseEventResult {
	/** Stop propagation and suppress renderer-level fallback behavior. */
	handled?: boolean;
	/** Route subsequent drag/release events to this component. Implies handled. */
	capture?: boolean;
	/** Give keyboard focus to this component. Implies handled. */
	focus?: boolean;
	/**
	 * Explicitly request or suppress a render. Move and release default to false;
	 * press, click, drag, and wheel default to true.
	 */
	render?: boolean;
}

/** Internal target metadata used by containers and alternate-screen dispatch. */
export interface TuiMouseDispatchTarget {
	component: Component;
	originX: number;
	originY: number;
	width: number;
	height: number;
}

/** Result of dispatching to a concrete component. */
export interface TuiMouseDispatchResult extends TuiMouseEventResult {
	handled: true;
	target: TuiMouseDispatchTarget;
	/** Keyboard focus target, which may be a delegating parent container. */
	focusTarget?: Component;
}

/**
 * Dispatch an event to a component and retain the exact target and coordinate
 * transform. Containers use this when forwarding events to nested children.
 */
export function dispatchMouseEvent(component: Component, event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
	const result = component.handleMouse?.(event);
	if (!result) return undefined;
	if ("target" in result) {
		// The component forwarded the event to a child it hosts. Like a delegating container, it routes
		// keys to that child itself, so it keeps keyboard focus. Focusing the child directly would leave
		// focus on a detached component once the host removes it, e.g. a closed settings submenu.
		const forwarded = result as TuiMouseDispatchResult;
		return forwarded.focus && component.handleInput ? { ...forwarded, focusTarget: component } : forwarded;
	}
	if (!result.handled && !result.capture && !result.focus) return undefined;
	return {
		...result,
		handled: true,
		...(result.focus ? { focusTarget: component } : {}),
		target: {
			component,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		},
	};
}

/** Recreate local coordinates for a previously dispatched mouse target. */
export function retargetMouseEvent(event: TuiMouseEvent, target: TuiMouseDispatchTarget): TuiMouseEvent {
	return {
		...event,
		x: event.screenX - target.originX,
		y: event.screenY - target.originY,
		width: target.width,
		height: target.height,
	};
}

export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/** Optional handler for keyboard input when component has focus. */
	handleInput?(data: string): void;

	/** Optional normalized mouse handler. */
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;

	/**
	 * Optional render revision for containers that cache child output.
	 *
	 * A number promises that `render(width)` returns the same lines for the same width, terminal
	 * capabilities and theme until the number changes; the component must change it whenever its
	 * state changes (including in `invalidate()`). `undefined` means the output may change at any
	 * time (streaming, animation, unknown dependencies), so the component is rendered every frame.
	 */
	getRenderRevision?(): number | undefined;

	dispose?(): void;
}

export type TuiInputListenerResult = { consume?: boolean; data?: string } | undefined;
export type TuiInputListener = (data: string) => TuiInputListenerResult;
type PendingTerminalColorQuery = {
	foreground?: RgbColor;
	background?: RgbColor;
	palette: Array<RgbColor | undefined>;
	/** Targets that already replied, so duplicates do not count twice. */
	replied: Set<string>;
	/**
	 * Receives the result: the promise's resolve until the timeout, then `onLateReply`. Unset once the
	 * query completed (on the DA1 reply or once every color replied); later replies are ignored.
	 */
	deliver: ((colors: TerminalColors) => void) | undefined;
	timer: NodeJS.Timeout | undefined;
};

interface ViewportInsertScrollPlan {
	viewportTop: number;
	regionBottom: number;
	insertedRows: string[];
	mutatedRows: Array<{ screenRow: number; content: string }>;
}

interface ViewportRenderStats {
	readonly lastNormalizedLines: number;
	readonly lastKittyImageScannedLines: number;
	readonly totalNormalizedLines: number;
	readonly totalKittyImageScannedLines: number;
	readonly boundedFrames: number;
	readonly escapedFrames: number;
	readonly fullFrames: number;
}

interface NormalizedLinesResult {
	readonly lines: string[];
	readonly firstRawChanged: number;
	readonly compareEndExclusive: number;
	readonly bounded: boolean;
}

/** Whether a specific line array contains an image line, so per-frame checks need not rescan it. */
interface ImageLineScan {
	readonly lines: string[];
	readonly hasImage: boolean;
}

const TERMINAL_PALETTE_SIZE = 16;
/** OSC 10 and 11 plus OSC 4 for every palette color. */
const TERMINAL_COLOR_REPLY_COUNT = 2 + TERMINAL_PALETTE_SIZE;
/**
 * Default colors, palette colors 0-15, and a trailing primary device attributes (DA1) request.
 * Every terminal answers DA1 and terminals answer in order, so the DA1 reply marks the end of
 * the color replies, including for terminals that ignore the color queries.
 */
const TERMINAL_COLOR_QUERY = `\x1b]10;?\x07\x1b]11;?\x07${Array.from(
	{ length: TERMINAL_PALETTE_SIZE },
	(_, index) => `\x1b]4;${index};?\x07`,
).join("")}\x1b[c`;
const DEVICE_ATTRIBUTES_RESPONSE_PATTERN = /^\x1b\[\?[\d;]*c$/;

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Only a component that can receive keys may own keyboard focus. A wrapper that merely
 * handles mouse events (MouseRegion and friends) has no handleInput, so focusing it would
 * silently swallow every later keystroke.
 */
export function canReceiveKeys(component: Component | null): boolean {
	return component !== null && typeof component.handleInput === "function";
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";
const FAKE_CURSOR_START = "\x1b[7m";
const FAKE_CURSOR_END = "\x1b[27m";
const FAKE_CURSOR_RESET = "\x1b[0m";

export { visibleWidth };

const renderErrorLoggedClasses = new Set<string>();
let renderErrorLogWrites = 0;
let renderDiagnosticLineScans = 0;
const DIAGNOSTIC_LOG_MODE = 0o600;

function defaultDiagnosticLogDirectory(): string {
	return path.join(os.homedir(), ".senpi", "agent");
}

/**
 * Render containment logs from module scope because `Container` has no TUI
 * instance, so the host-resolved log directory has to be published here or the
 * diagnostic silently lands outside the agent directory the operator reads.
 */
let renderErrorLogDirectory: string | undefined;
const VIEWPORT_RENDER_OVERSCAN = 16;
// Keep scroll-region wins cheap when a few visible rows mutate during append streaming.
const MAX_SCROLL_DIFF_ROWS = 4;
const viewportRenderStats = {
	lastNormalizedLines: 0,
	lastKittyImageScannedLines: 0,
	totalNormalizedLines: 0,
	totalKittyImageScannedLines: 0,
	boundedFrames: 0,
	escapedFrames: 0,
	fullFrames: 0,
};

export function __renderErrorLogStats(): { writes: number } | undefined {
	if (process.env.PI_TUI_TEST_SEAMS !== "1") {
		return undefined;
	}
	return { writes: renderErrorLogWrites };
}

export function __renderDiagnosticStats(): { linesScanned: number } | undefined {
	if (process.env.PI_TUI_TEST_SEAMS !== "1") {
		return undefined;
	}
	return { linesScanned: renderDiagnosticLineScans };
}

export function __viewportRenderStats(): ViewportRenderStats | undefined {
	if (process.env.PI_TUI_TEST_SEAMS !== "1") {
		return undefined;
	}
	return { ...viewportRenderStats };
}

function recordViewportRenderStats(normalizedLines: number, mode: "bounded" | "escaped" | "full"): void {
	viewportRenderStats.lastNormalizedLines = normalizedLines;
	viewportRenderStats.totalNormalizedLines += normalizedLines;
	if (mode === "bounded") {
		viewportRenderStats.boundedFrames += 1;
	} else if (mode === "escaped") {
		viewportRenderStats.escapedFrames += 1;
	} else {
		viewportRenderStats.fullFrames += 1;
	}
}

function recordKittyImageScanStats(scannedLines: number): void {
	viewportRenderStats.lastKittyImageScannedLines = scannedLines;
	viewportRenderStats.totalKittyImageScannedLines += scannedLines;
}

function componentRenderErrorName(component: Component): string {
	return component.constructor.name || "AnonymousComponent";
}

function logRenderErrorOnce(component: Component, error: unknown): void {
	const componentName = componentRenderErrorName(component);
	if (renderErrorLoggedClasses.has(componentName)) {
		return;
	}
	renderErrorLoggedClasses.add(componentName);
	renderErrorLogWrites += 1;

	const errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	const logPath = path.join(renderErrorLogDirectory ?? defaultDiagnosticLogDirectory(), "senpi-debug.log");
	const msg = `[${new Date().toISOString()}] render error: ${componentName}: ${errorText}\n`;
	appendRenderErrorLogBestEffort(logPath, msg);
}

function appendRenderErrorLogBestEffort(logPath: string, msg: string): void {
	try {
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.appendFileSync(logPath, msg, { encoding: "utf8", mode: DIAGNOSTIC_LOG_MODE });
		chmodDiagnosticLogBestEffort(logPath);
	} catch (error) {
		if (error instanceof Error) {
			return;
		}
		throw error;
	}
}

function writeRenderDiagnosticBestEffort(logPath: string, data: string): boolean {
	try {
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.writeFileSync(logPath, data, { encoding: "utf8", mode: DIAGNOSTIC_LOG_MODE });
		chmodDiagnosticLogBestEffort(logPath);
		return true;
	} catch (error) {
		if (error instanceof Error) {
			return false;
		}
		throw error;
	}
}

function formatOverWideRenderDiagnostic(
	lines: readonly string[],
	terminalWidth: number,
	lineIndex: number,
	lineWidth: number,
): string {
	renderDiagnosticLineScans += lines.length;
	return [
		`Crash at ${new Date().toISOString()}`,
		`Terminal width: ${terminalWidth}`,
		`Line ${lineIndex} visible width: ${lineWidth}`,
		"",
		"=== All rendered lines ===",
		...lines.map((line, index) => `[${index}] (w=${visibleWidth(line)}) ${line}`),
		"",
	].join("\n");
}

function chmodDiagnosticLogBestEffort(logPath: string): void {
	try {
		fs.chmodSync(logPath, DIAGNOSTIC_LOG_MODE);
	} catch (error) {
		if (error instanceof Error) {
			return;
		}
		throw error;
	}
}

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** If true, don't capture keyboard focus when shown */
	nonCapturing?: boolean;
}

/** Options for {@link OverlayHandle.unfocus}. */
export interface OverlayUnfocusOptions {
	/** Explicit target to focus after releasing this overlay. */
	target: Component | null;
}

/** Last rendered terminal-relative overlay rectangle. */
export interface OverlayBounds {
	row: number;
	col: number;
	width: number;
	height: number;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
	/** Focus this overlay and bring it to the visual front */
	focus(): void;
	/** Release focus to the next visible capturing overlay or previous target, or to an explicit target when provided */
	unfocus(options?: OverlayUnfocusOptions): void;
	/** Check if this overlay currently has focus */
	isFocused(): boolean;
	/** Get the most recent rendered bounds for a visible overlay. */
	getBounds(): OverlayBounds | undefined;
}

type OverlayStackEntry = {
	component: Component;
	options?: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
	focusOrder: number;
	bounds?: OverlayBounds;
};

type RenderedOverlayLayout = {
	entry: OverlayStackEntry;
	row: number;
	col: number;
	width: number;
	height: number;
};

type OverlayBlockedFocusResume = { status: "restore-overlay" } | { status: "focus-target"; target: Component | null };
type EligibleOverlayFocusRestoreState = { status: "eligible"; overlay: OverlayStackEntry };
type BlockedOverlayFocusRestoreState = {
	status: "blocked";
	overlay: OverlayStackEntry;
	blockedBy: Component;
	resume: OverlayBlockedFocusResume;
};
type ActiveOverlayFocusRestoreState = EligibleOverlayFocusRestoreState | BlockedOverlayFocusRestoreState;
type OverlayFocusRestoreState = { status: "inactive" } | ActiveOverlayFocusRestoreState;
type OverlayFocusRestorePolicy = "clear" | "preserve";
type TuiConstructorOptions = {
	showHardwareCursor?: boolean;
	muxDetector?: () => boolean;
};

/**
 * Container - a component that contains other components
 */
/**
 * Facts about the frame being rendered, published by the main-screen renderer for containers that
 * can skip work for rows the terminal cannot repaint cheaply.
 */
const renderFrame: {
	scrollbackRows: number;
	offset: number;
	next: Component | undefined;
	mode: TuiMode | undefined;
	rows: number;
} = {
	scrollbackRows: 0,
	offset: 0,
	next: undefined,
	mode: undefined,
	rows: 0,
};

/** Mode of the renderer drawing the current frame, or `undefined` outside a frame. */
export function frameMode(): TuiMode | undefined {
	return renderFrame.mode;
}

const DEFAULT_HISTORY_LINES = 2000;
/** Writing this many lines into a terminal takes ~0.2 s, the most a resume or repaint may spend on history. */
const MAX_HISTORY_LINES = 5000;
let terminalScrollbackLines: number | null | undefined;
/** Bumped by {@link resetMainScreenHistoryLines}, so a tmux answer for an older environment is dropped. */
let scrollbackLookupGeneration = 0;

/**
 * The override is read at once; tmux is asked in the background (a process run inside the first
 * render would hold input and painting while tmux answers), and the default applies until it does.
 */
function readTerminalScrollbackLines(): number | null {
	const override = Number(process.env.PI_TUI_HISTORY_LINES);
	if (Number.isFinite(override) && override > 0) return Math.floor(override);
	if (!process.env.TMUX) return null;
	const generation = scrollbackLookupGeneration;
	try {
		execFile(
			"tmux",
			["display-message", "-p", "#{history_limit}"],
			{ encoding: "utf8", timeout: 500 },
			(error, stdout) => {
				if (generation !== scrollbackLookupGeneration) return;
				const limit = Number(stdout.trim());
				if (!error && Number.isFinite(limit) && limit > 0) terminalScrollbackLines = limit;
			},
		);
	} catch {
		// tmux is not runnable: keep the default.
	}
	return null;
}

/**
 * Lines of transcript history a main-screen frame keeps above the live area: the terminal's own
 * scrollback size where it can be read (tmux `history-limit`, or `PI_TUI_HISTORY_LINES`), else
 * 2,000; never less than two screens, never more than 5,000 so a resume or repaint stays instant.
 */
export function mainScreenHistoryLines(rows = renderFrame.rows): number {
	if (terminalScrollbackLines === undefined) terminalScrollbackLines = readTerminalScrollbackLines();
	const preferred = Math.min(MAX_HISTORY_LINES, terminalScrollbackLines ?? DEFAULT_HISTORY_LINES);
	return Math.min(MAX_HISTORY_LINES, Math.max(2 * Math.max(1, rows), preferred));
}

/** Forget the measured terminal scrollback size, e.g. after the environment changed in a test. */
export function resetMainScreenHistoryLines(): void {
	terminalScrollbackLines = undefined;
	scrollbackLookupGeneration += 1;
}

/**
 * Rows at the top of the last committed frame that now live in the terminal's native scrollback
 * (main-screen renderer, same terminal size). Changing any of them forces a full scrollback replay.
 * 0 outside such a frame.
 */
export function frameScrollbackRows(): number {
	return renderFrame.scrollbackRows;
}

/**
 * The absolute frame row where `component` starts, when its parent rendered it through
 * {@link renderAtFrameRow}; `undefined` when the position is unknown (any other parent).
 */
export function claimFrameRow(component: Component): number | undefined {
	if (renderFrame.next !== component) return undefined;
	renderFrame.next = undefined;
	return renderFrame.offset;
}

/** Render `child` as starting at absolute frame row `row`, so it can {@link claimFrameRow} it. */
export function renderAtFrameRow(child: Component, width: number, row: number | undefined): string[] {
	if (row === undefined) return child.render(width);
	const previousOffset = renderFrame.offset;
	const previousNext = renderFrame.next;
	renderFrame.offset = row;
	renderFrame.next = child;
	try {
		return child.render(width);
	} finally {
		renderFrame.offset = previousOffset;
		renderFrame.next = previousNext;
	}
}

let renderRevisionClock = 0;

/**
 * Draw a new value from the process-wide render revision clock. Every revisioned state change uses
 * one, so "the clock has not moved" proves no revisioned component changed and caches may skip
 * re-reading their children's revisions.
 */
export function nextRenderRevision(): number {
	renderRevisionClock += 1;
	return renderRevisionClock;
}

/** Current value of the render revision clock (see {@link nextRenderRevision}). */
export function currentRenderRevision(): number {
	return renderRevisionClock;
}

/**
 * Byte cost of the frame the TUI last held, summed over every live TUI in the process (senpi#1960):
 * `previousLines` is the whole frame a terminal keeps for the differential pass, so a long session's
 * transcript cost lives here. The memory report reads the figure structurally through a process-global
 * key; a process with no TUI reports no figure. Estimator: 2 bytes per UTF-16 code unit plus an 8-byte
 * array slot per line - the same estimate the tool-card render cache uses, so the two figures compare.
 */
const FRAME_LINE_BYTES_KEY = Symbol.for("senpi.tui.frame-line-bytes");

export interface FrameLineBytesTotals {
	readonly previousLinesBytes: number;
}

function frameLineBytesState(): { bytes: number } {
	const existing: unknown = Reflect.get(globalThis, FRAME_LINE_BYTES_KEY);
	if (typeof existing === "object" && existing !== null && typeof Reflect.get(existing, "bytes") === "number") {
		return existing as { bytes: number };
	}
	const created = { bytes: 0 };
	Reflect.set(globalThis, FRAME_LINE_BYTES_KEY, created);
	return created;
}

/** Sum of every live TUI's current frame-line bytes; `0` before any frame renders. */
export function frameLineBytesTotals(): FrameLineBytesTotals {
	return { previousLinesBytes: frameLineBytesState().bytes };
}

/**
 * Render revision of a component whose output is a pure function of its own state and its children's
 * output. `bump()` records an own-state change; `read(children)` returns a revision that also changes
 * whenever a child is replaced or a child's revision changes, and `undefined` while any child is live.
 * Child revisions are re-read only after the clock moved, so an unchanged subtree costs one identity pass.
 */
export class CompositeRevision {
	private revision = nextRenderRevision();
	private children: readonly Component[] = [];
	private childRevisions: readonly number[] = [];
	private checkedAt = -1;

	bump(): void {
		this.revision = nextRenderRevision();
	}

	read(children: readonly Component[]): number | undefined {
		let replaced = children.length !== this.children.length;
		for (let index = 0; !replaced && index < children.length; index++) {
			if (children[index] !== this.children[index]) replaced = true;
		}
		if (!replaced && this.checkedAt === renderRevisionClock) return this.revision;
		const revisions: number[] = [];
		for (const child of children) {
			const revision = child.getRenderRevision?.();
			if (revision === undefined) {
				// Unrevisioned: nothing to compare against next time, and removed children must not stay referenced.
				this.children = [];
				this.childRevisions = [];
				this.checkedAt = -1;
				return undefined;
			}
			revisions.push(revision);
		}
		const changed = replaced || revisions.some((revision, index) => revision !== this.childRevisions[index]);
		if (changed) {
			this.revision = nextRenderRevision();
			this.children = [...children];
		}
		this.childRevisions = revisions;
		this.checkedAt = renderRevisionClock;
		return this.revision;
	}
}

export class Container implements Component {
	children: Component[] = [];
	private disposed = false;
	private readonly composite = new CompositeRevision();
	private mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };

	// Every structural change moves the render revision clock, so a cache that saw the clock stand
	// still may trust that no revisioned subtree gained, lost or swapped a child.
	addChild(component: Component): void {
		this.children.push(component);
		this.composite.bump();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.composite.bump();
			component.dispose?.();
		}
	}

	detachChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.composite.bump();
		}
	}

	clear(): void {
		for (const child of this.children) {
			child.dispose?.();
		}
		this.children = [];
		this.composite.bump();
	}

	detachAll(): void {
		this.children = [];
		this.composite.bump();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const child of this.children) {
			child.dispose?.();
		}
	}

	invalidate(): void {
		this.composite.bump();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	/**
	 * A plain `Container` only concatenates its children, so its output changes exactly when a child
	 * changes. Subclasses may render more than their children and therefore opt in explicitly by
	 * overriding this (usually via {@link childRenderRevision}); an inherited revision would let a
	 * cache keep their stale output.
	 */
	getRenderRevision(): number | undefined {
		return Object.getPrototypeOf(this) === Container.prototype ? this.childRenderRevision() : undefined;
	}

	/** Revision of this container's children, for subclasses whose output depends only on them and `bump()`ed state. */
	protected childRenderRevision(): number | undefined {
		return this.composite.read(this.children);
	}

	/** Record an own-state change for {@link childRenderRevision}. */
	protected bumpRenderRevision(): void {
		this.composite.bump();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (event.y < 0 || event.y >= event.height) return undefined;
		const mouseChildren =
			this.mouseLayout?.width === event.width
				? this.mouseLayout.children
				: this.children.map((component) => ({ component, height: component.render(event.width).length }));
		let childY = 0;
		for (const { component: child, height: childHeight } of mouseChildren) {
			if (event.y >= childY && event.y < childY + childHeight) {
				const result = dispatchMouseEvent(child, {
					...event,
					y: event.y - childY,
					height: childHeight,
				});
				if (result?.focus && (this as Component).handleInput) return { ...result, focusTarget: this };
				return result;
			}
			childY += childHeight;
		}
		return undefined;
	}

	render(width: number): string[] {
		const chunks: string[][] = [];
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		let row = claimFrameRow(this);
		for (const child of this.children) {
			let childLines: string[];
			try {
				childLines = renderAtFrameRow(child, width, row);
			} catch (error) {
				logRenderErrorOnce(child, error);
				const componentName = componentRenderErrorName(child);
				// Focus ownership stays unchanged; render containment must not steal or clear focus implicitly.
				childLines = [`[render error: ${componentName}]`];
			}
			mouseChildren.push({ component: child, height: childLines.length });
			chunks.push(childLines);
			if (row !== undefined) row += childLines.length;
		}
		this.mouseLayout = { width, children: mouseChildren };
		return joinLineArrays(chunks);
	}
}

const JOIN_BATCH = 1024;

/**
 * Concatenate rendered line arrays into one new array. Native `concat` copies whole arrays at once,
 * which keeps a frame over a long transcript from paying a per-line iterator and push.
 */
export function joinLineArrays(chunks: readonly (readonly string[])[]): string[] {
	if (chunks.length <= JOIN_BATCH) return ([] as string[]).concat(...chunks);
	const batches: string[][] = [];
	for (let start = 0; start < chunks.length; start += JOIN_BATCH) {
		batches.push(([] as string[]).concat(...chunks.slice(start, start + JOIN_BATCH)));
	}
	return ([] as string[]).concat(...batches);
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

/** Composite overlay content into a terminal line at a fixed column. */
export function compositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (isImageLine(baseLine) && visibleWidth(baseLine) === 0) return baseLine;
	const placeholderIndex = baseLine.indexOf("\u{10eeee}");
	const protocolEnd = placeholderIndex === -1 ? -1 : baseLine.lastIndexOf("\x1b\\", placeholderIndex);
	const protocolPrefix = protocolEnd === -1 ? "" : baseLine.slice(0, protocolEnd + 2);

	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);
	const result =
		base.before +
		" ".repeat(beforePad) +
		SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);

	const composited = visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
	return protocolPrefix + composited;
}

export type TuiMode = "regular" | "fullscreen";

export interface TuiStopOptions {
	/** Leave renderer output in place for another TUI taking over the same terminal. */
	preserveScreen?: boolean;
}

/**
 * Structural contract every renderer satisfies. The concrete `TUI` class below is the
 * fork's legacy main-screen renderer and owns this name in both the value and type
 * position, so the upstream `interface TUI` cannot be declared alongside it; the members
 * upstream added to that interface (`mode`, `stop(options)`, `renderNow`) live on
 * `TuiBase` and are therefore present on every renderer typed as `TUI`.
 */
export const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

export interface ViewportTUI extends TUI {
	readonly [VIEWPORT_TUI]: true;
	setLayoutRoot(component: Component | undefined): void;
}

export function isViewportTUI(tui: TUI): tui is ViewportTUI {
	return (tui as Partial<ViewportTUI>)[VIEWPORT_TUI] === true;
}

export abstract class TuiBase extends Container {
	abstract readonly mode: TuiMode;
	public terminal: Terminal;
	protected previousLines: string[] = [];
	private previousRawLines: string[] = [];
	private previousImageScan: ImageLineScan | undefined;
	/** Image presence the normalization pass already measured for the array it produced. */
	private normalizedImageHint: ImageLineScan | undefined;
	private normalizeMemo = new Map<string, string>();
	protected previousKittyImageIds = new Set<number>();
	/** A multiplexer pane regained focus: the next frame repaints its viewport once (senpi#1704). */
	#muxViewportRepaintPending = false;
	protected previousWidth = 0;
	protected previousHeight = 0;
	private focusedComponent: Component | null = null;
	private inputListeners = new Set<TuiInputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	private renderRequested = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	/** Minimum interval between scheduled renders. Default preserves the historic ~60fps cap. */
	#minRenderIntervalMs = 16;
	private inputRenderPending = false;
	protected cursorRow = 0; // Logical cursor row (end of rendered content)
	protected hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	private showHardwareCursor = process.env.PI_HARDWARE_CURSOR === "1";
	private clearOnShrink = process.env.PI_CLEAR_ON_SHRINK === "1"; // Clear empty rows when content shrinks (default: off)
	protected maxLinesRendered = 0; // Track terminal's working area (max lines ever rendered)
	protected previousViewportTop = 0; // Track previous viewport top for resize-aware cursor moves
	protected fullRedrawCount = 0;
	private muxViewportRepaintCount = 0;
	private overWideCrashDumpWritten = false;
	protected stopped = false;
	/**
	 * Color queries waiting for their DA1 reply, oldest first. Terminals answer in order, so color
	 * replies belong to the oldest one. Queries stay here after a timeout to collect late replies.
	 */
	private pendingTerminalColorQueries: PendingTerminalColorQuery[] = [];
	private terminalColorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
	private terminalColorSchemeNotificationsEnabled = false;
	#lastCursorVisibility: boolean | undefined;
	#holdScrollbackReplay = false;
	#releaseHoldOnInput = false;
	#scrollbackStale = false;
	#scrollbackCatchUpPending = false;
	/** Directory for debug/crash logs. The fork keeps a concrete default (`~/.senpi/agent`) so PI_DEBUG_REDRAW and crash dumps stay in the agent directory. */
	protected readonly logDirectory: string;

	// Overlay stack for modal components rendered on top of base content
	private focusOrderCounter = 0;
	private overlayStack: OverlayStackEntry[] = [];
	private renderedOverlayLayouts: RenderedOverlayLayout[] = [];

	get hasOverlayEntries(): boolean {
		return this.overlayStack.length > 0;
	}
	private overlayFocusRestore: OverlayFocusRestoreState = { status: "inactive" };
	#muxDetector: () => boolean;

	constructor(terminal: Terminal, options?: boolean | TuiConstructorOptions, logDirectory?: string) {
		super();
		this.terminal = terminal;
		// Preserve existing positional boolean callers while allowing explicit render-policy overrides.
		const normalizedOptions = typeof options === "boolean" ? { showHardwareCursor: options } : (options ?? {});
		this.#muxDetector = normalizedOptions.muxDetector ?? isMultiplexerSession;
		this.logDirectory = logDirectory ?? defaultDiagnosticLogDirectory();
		renderErrorLogDirectory = this.logDirectory;
		if (normalizedOptions.showHardwareCursor !== undefined) {
			this.showHardwareCursor = normalizedOptions.showHardwareCursor;
		}
	}

	private mouseLeases = new Map<symbol, string>();
	private mouseBlockers = new Set<"suspended" | "external-editor" | "shutting-down">();
	protected placementEpoch = 0;
	protected anchor: {
		kind: "unknown" | "cleared" | "viewport" | "cpr";
		frameTopScreenRow?: number;
		epoch: number;
		rows: number;
		columns: number;
	} = { kind: "unknown", epoch: 0, rows: 0, columns: 0 };
	private mouseCommittedLineCount = 0;
	private mouseAnchorPending = false;
	private mouseWriteUnsubscribe?: () => void;
	protected mouseExternalWritePending = false;

	/** Host-owned intent. A replacement renderer starts with no leases. */
	acquireMouseCapture(reason: string): () => void {
		const token = Symbol(reason);
		const first = this.mouseLeases.size === 0;
		this.mouseLeases.set(token, reason);
		if (first) {
			this.mouseWriteUnsubscribe ??= this.terminal.observeExternalWrites?.(() => {
				this.placementEpoch++;
				this.mouseExternalWritePending = true;
			});
			this.applyMouseTracking(this.mouseCaptureEnabled);
			this.calibrateMouseAnchor();
		}
		return () => {
			if (!this.mouseLeases.delete(token)) return;
			if (this.mouseLeases.size === 0) this.applyMouseTracking(false);
		};
	}

	private resetMouseCaptureState(): void {
		this.mouseLeases.clear();
		this.mouseBlockers.clear();
		this.mouseWriteUnsubscribe?.();
		this.mouseWriteUnsubscribe = undefined;
		this.placementEpoch++;
	}

	protected get mouseCaptureEnabled(): boolean {
		return this.mouseLeases.size > 0 && this.mouseBlockers.size === 0;
	}

	protected applyMouseTracking(_enabled: boolean): void {}

	protected getMouseLayoutRoots(): readonly Component[] {
		return [...this.getMountedRoots(), ...this.renderedOverlayLayouts.map((layout) => layout.entry.component)];
	}

	protected setMouseBlocker(name: "suspended" | "external-editor" | "shutting-down", on: boolean): void {
		if (this.mouseBlockers.has(name) === on) return;
		if (on) this.mouseBlockers.add(name);
		else this.mouseBlockers.delete(name);
		this.placementEpoch++;
		this.applyMouseTracking(this.mouseCaptureEnabled);
	}

	protected noteFullRender(clear: boolean): void {
		this.placementEpoch++;
		this.anchor = {
			kind: clear ? "cleared" : "unknown",
			frameTopScreenRow: clear ? 0 : undefined,
			epoch: this.placementEpoch,
			rows: this.terminal.rows,
			columns: this.terminal.columns,
		};
		this.mouseCommittedLineCount = this.previousLines.length;
		this.noteCommittedMouseFrame();
		this.calibrateMouseAnchor();
	}

	/** Called only after the renderer has published its geometry and bytes. */
	protected noteCommittedMouseFrame(): void {
		if (this.mouseCommittedLineCount !== this.previousLines.length) this.placementEpoch++;
		this.mouseCommittedLineCount = this.previousLines.length;
		if (this.previousLinesHaveImage()) {
			this.placementEpoch++;
			this.anchor.kind = "unknown";
			return;
		}
		if (this.previousLines.length >= this.terminal.rows) {
			this.anchor = {
				kind: "viewport",
				epoch: this.placementEpoch,
				rows: this.terminal.rows,
				columns: this.terminal.columns,
			};
		} else if (
			this.anchor.epoch !== this.placementEpoch ||
			this.anchor.rows !== this.terminal.rows ||
			this.anchor.columns !== this.terminal.columns
		) {
			this.anchor = {
				kind: "unknown",
				epoch: this.placementEpoch,
				rows: this.terminal.rows,
				columns: this.terminal.columns,
			};
		}
	}

	/** Never block a frame on terminal protocol negotiation or a missing reply. */
	protected calibrateMouseAnchor(): void {
		if (
			!this.mouseCaptureEnabled ||
			this.stopped ||
			this.mouseAnchorPending ||
			this.mouseExternalWritePending ||
			!this.terminal.queryCursorPosition ||
			this.previousLines.length === 0 ||
			this.previousLinesHaveImage()
		)
			return;
		if (
			this.anchor.kind !== "unknown" &&
			this.anchor.epoch === this.placementEpoch &&
			this.anchor.rows === this.terminal.rows &&
			this.anchor.columns === this.terminal.columns
		)
			return;
		const epoch = this.placementEpoch;
		const rows = this.terminal.rows;
		const columns = this.terminal.columns;
		const hardwareCursorRow = this.hardwareCursorRow;
		const lineCount = this.previousLines.length;
		this.mouseAnchorPending = true;
		void this.terminal.queryCursorPosition().then((position) => {
			this.mouseAnchorPending = false;
			if (
				!position ||
				this.stopped ||
				!this.mouseCaptureEnabled ||
				epoch !== this.placementEpoch ||
				rows !== this.terminal.rows ||
				columns !== this.terminal.columns ||
				hardwareCursorRow !== this.hardwareCursorRow ||
				lineCount !== this.previousLines.length
			)
				return;
			const top = position.row - 1 - hardwareCursorRow;
			if (
				!Number.isSafeInteger(top) ||
				top < 0 ||
				top + lineCount > rows ||
				!Number.isSafeInteger(position.column) ||
				position.column < 1 ||
				// Some emulators report the pending-wrap cell just past the right edge.
				position.column > columns + 1 ||
				(position.page !== undefined && position.page !== 1)
			)
				return;
			this.anchor = { kind: "cpr", frameTopScreenRow: top, epoch, rows, columns };
		});
	}

	/** Input rows are one-based; the returned committed frame line is zero-based. */
	protected resolveFrameLine(screenRow: number): number | undefined {
		const anchor = this.anchor;
		if (
			anchor.kind === "unknown" ||
			anchor.epoch !== this.placementEpoch ||
			anchor.rows !== this.terminal.rows ||
			anchor.columns !== this.terminal.columns ||
			screenRow < 1 ||
			screenRow > anchor.rows
		)
			return undefined;
		const line =
			anchor.kind === "viewport"
				? this.previousViewportTop + screenRow - 1
				: screenRow - 1 - (anchor.frameTopScreenRow ?? 0);
		return line >= 0 && line < this.previousLines.length ? line : undefined;
	}

	protected resetRenderState(): void {}

	protected beforeTerminalStart(): void {}

	protected afterTerminalStart(): void {}

	protected beforeTerminalStop(_options: TuiStopOptions): void {}

	protected afterTerminalStop(_options: TuiStopOptions): void {}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	get muxViewportRepaints(): number {
		return this.muxViewportRepaintCount;
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true, empty rows are cleared when content shrinks.
	 * When false (default), empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	getFocusedComponent(): Component | null {
		return this.focusedComponent;
	}

	setFocus(component: Component | null): void {
		this.setFocusInternal({ component, overlayFocusRestore: "clear" });
	}

	private setFocusInternal({
		component,
		overlayFocusRestore,
	}: {
		component: Component | null;
		overlayFocusRestore: OverlayFocusRestorePolicy;
	}): void {
		const previousFocus = this.focusedComponent;
		let nextFocus = component;
		const previousFocusedOverlay = previousFocus
			? this.overlayStack.find((entry) => entry.component === previousFocus && this.isOverlayVisible(entry))
			: undefined;
		const nextFocusIsOverlay = nextFocus ? this.overlayStack.some((entry) => entry.component === nextFocus) : false;
		const restoreState = this.getVisibleOverlayFocusRestore();
		if (nextFocus && !nextFocusIsOverlay) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				if (restoreState.resume.status === "focus-target" || !this.isComponentMounted(restoreState.blockedBy)) {
					nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
				} else {
					this.overlayFocusRestore = {
						status: "blocked",
						overlay: restoreState.overlay,
						blockedBy: nextFocus,
						resume: restoreState.resume,
					};
				}
			} else if (
				previousFocusedOverlay &&
				restoreState.status !== "inactive" &&
				restoreState.overlay === previousFocusedOverlay &&
				!this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)
			) {
				this.overlayFocusRestore = {
					status: "blocked",
					overlay: previousFocusedOverlay,
					blockedBy: nextFocus,
					resume: { status: "restore-overlay" },
				};
			}
		} else if (nextFocus === null) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
			} else if (overlayFocusRestore === "clear") {
				this.clearOverlayFocusRestore();
			}
		}

		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = nextFocus;

		if (isFocusable(nextFocus)) {
			nextFocus.focused = true;
		}

		const focusedOverlay = nextFocus
			? this.overlayStack.find((entry) => entry.component === nextFocus && this.isOverlayVisible(entry))
			: undefined;
		if (focusedOverlay) {
			this.overlayFocusRestore = { status: "eligible", overlay: focusedOverlay };
		}
	}

	private clearOverlayFocusRestore(): void {
		this.overlayFocusRestore = { status: "inactive" };
	}

	private clearOverlayFocusRestoreFor(overlay: OverlayStackEntry): void {
		if (this.overlayFocusRestore.status !== "inactive" && this.overlayFocusRestore.overlay === overlay) {
			this.clearOverlayFocusRestore();
		}
	}

	private resolveBlockedOverlayFocusResume(restoreState: BlockedOverlayFocusRestoreState): Component | null {
		if (restoreState.resume.status === "restore-overlay") return restoreState.overlay.component;
		this.clearOverlayFocusRestore();
		return restoreState.resume.target;
	}

	private getVisibleOverlayFocusRestore(): OverlayFocusRestoreState {
		const restoreState = this.overlayFocusRestore;
		if (restoreState.status === "inactive") return restoreState;
		if (!this.overlayStack.includes(restoreState.overlay) || !this.isOverlayVisible(restoreState.overlay)) {
			return { status: "inactive" };
		}
		return restoreState;
	}

	private isOverlayFocusAncestor(entry: OverlayStackEntry, component: Component): boolean {
		const visited = new Set<Component>();
		let current = entry.preFocus;
		while (current && !visited.has(current)) {
			visited.add(current);
			if (current === component) return true;
			current = this.overlayStack.find((overlay) => overlay.component === current)?.preFocus ?? null;
		}
		return false;
	}

	private retargetOverlayPreFocus(removed: OverlayStackEntry): void {
		for (const overlay of this.overlayStack) {
			if (overlay !== removed && overlay.preFocus === removed.component) {
				overlay.preFocus = removed.preFocus;
			}
		}
	}

	protected getMountedRoots(): readonly Component[] {
		return this.children;
	}

	private isComponentMounted(component: Component): boolean {
		return this.getMountedRoots().some((child) => this.containsComponent(child, component));
	}

	private containsComponent(root: Component, target: Component): boolean {
		if (root === target) return true;
		if (!(root instanceof Container)) return false;
		return root.children.some((child) => this.containsComponent(child, target));
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: OverlayStackEntry = {
			component,
			...(options === undefined ? {} : { options }),
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
		};
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.#setCursorVisibility(false);
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.clearOverlayFocusRestoreFor(entry);
					this.retargetOverlayPreFocus(entry);
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.#setCursorVisibility(false);
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					this.clearOverlayFocusRestoreFor(entry);
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				entry.focusOrder = ++this.focusOrderCounter;
				this.setFocus(component);
				this.requestRender();
			},
			unfocus: (unfocusOptions) => {
				const isFocused = this.focusedComponent === component;
				const restoreState = this.overlayFocusRestore;
				const hasPendingRestore = restoreState.status !== "inactive" && restoreState.overlay === entry;
				if (!isFocused && !hasPendingRestore) return;
				if (
					restoreState.status === "blocked" &&
					restoreState.overlay === entry &&
					this.focusedComponent === restoreState.blockedBy
				) {
					if (unfocusOptions) {
						this.overlayFocusRestore = {
							status: "blocked",
							overlay: entry,
							blockedBy: restoreState.blockedBy,
							resume: { status: "focus-target", target: unfocusOptions.target },
						};
					} else {
						this.clearOverlayFocusRestore();
					}
					this.requestRender();
					return;
				}
				this.clearOverlayFocusRestoreFor(entry);
				if (isFocused || unfocusOptions) {
					const topVisible = this.getTopmostVisibleOverlay();
					const fallbackTarget = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
					this.setFocus(unfocusOptions ? unfocusOptions.target : fallbackTarget);
				}
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
			getBounds: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry) || !entry.bounds) return undefined;
				return { ...entry.bounds };
			},
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack[this.overlayStack.length - 1];
		if (!overlay) return;
		this.clearOverlayFocusRestoreFor(overlay);
		this.retargetOverlayPreFocus(overlay);
		this.overlayStack.pop();
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.#setCursorVisibility(false);
		this.requestRender();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** Check if the focused component is a visible overlay */
	protected isOverlayFocused(): boolean {
		return this.overlayStack.some(
			(entry) => entry.component === this.focusedComponent && this.isOverlayVisible(entry),
		);
	}

	/**
	 * Keyboard focus owner for a clicked component: the overlay that owns it, else the component
	 * itself when it can receive keys, else the nearest surrounding component that can. Null when
	 * nothing in that chain can - a mouse-only control (a clickable row, a tab strip) that owned
	 * focus would swallow every later keystroke.
	 */
	protected resolveMouseFocusTarget(component: Component): Component | null {
		for (let index = this.overlayStack.length - 1; index >= 0; index--) {
			const overlay = this.overlayStack[index]!;
			if (this.isOverlayVisible(overlay) && this.containsComponent(overlay.component, component)) {
				return overlay.component;
			}
		}
		if (canReceiveKeys(component)) return component;
		return this.findKeyFocusOwner(component);
	}

	/** Deepest mounted ancestor of `target` that can receive keys, excluding `target` itself. */
	private findKeyFocusOwner(target: Component): Component | null {
		const path: Component[] = [];
		const walk = (node: Component): boolean => {
			path.push(node);
			if (node === target) return true;
			if (node instanceof Container) {
				for (const child of node.children) if (walk(child)) return true;
			}
			path.pop();
			return false;
		};
		for (const root of this.getMouseLayoutRoots()) {
			path.length = 0;
			if (!walk(root)) continue;
			for (let index = path.length - 2; index >= 0; index--) {
				const candidate = path[index]!;
				if (canReceiveKeys(candidate)) return candidate;
			}
			return null;
		}
		return null;
	}

	/** Dispatch to the visually topmost overlay under the pointer. */
	protected dispatchMouseToOverlay(event: TuiMouseEvent): { hit: boolean; result?: TuiMouseDispatchResult } {
		for (let index = this.renderedOverlayLayouts.length - 1; index >= 0; index--) {
			const layout = this.renderedOverlayLayouts[index]!;
			if (
				event.screenX < layout.col ||
				event.screenX >= layout.col + layout.width ||
				event.screenY < layout.row ||
				event.screenY >= layout.row + layout.height
			) {
				continue;
			}
			const result = dispatchMouseEvent(layout.entry.component, {
				...event,
				x: event.screenX - layout.col,
				y: event.screenY - layout.row,
				width: layout.width,
				height: layout.height,
			});
			return result
				? {
						hit: true,
						result: result.focus ? { ...result, focusTarget: layout.entry.component } : result,
					}
				: { hit: true };
		}
		return { hit: false };
	}

	/** Check if an overlay entry is currently visible */
	private isOverlayVisible(entry: OverlayStackEntry): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the visual-frontmost visible capturing overlay, if any */
	private getTopmostVisibleOverlay(): OverlayStackEntry | undefined {
		let topmost: OverlayStackEntry | undefined;
		for (const overlay of this.overlayStack) {
			if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay)) continue;
			if (!topmost || overlay.focusOrder > topmost.focusOrder) {
				topmost = overlay;
			}
		}
		return topmost;
	}

	override invalidate(): void {
		for (const root of this.getMountedRoots()) root.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate();
	}

	start(): void {
		this.stopped = false;
		this.renderRequested = false;
		this.inputRenderPending = false;
		this.#lastCursorVisibility = undefined;
		this.beforeTerminalStart();
		this.terminal.start(
			(data) => this.handleTerminalInput(data),
			() => this.requestRender(),
		);
		this.afterTerminalStart();
		if (process.env.TMUX) this.terminal.write(ENABLE_FOCUS_REPORTING);
		this.#setCursorVisibility(false);
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031h");
		}
		this.queryCellSize();
		this.requestRender();
	}

	addInputListener(listener: TuiInputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: TuiInputListener): void {
		this.inputListeners.delete(listener);
	}

	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		this.terminalColorSchemeListeners.add(listener);
		return () => {
			this.terminalColorSchemeListeners.delete(listener);
		};
	}

	setTerminalColorSchemeNotifications(enabled: boolean): void {
		if (this.terminalColorSchemeNotificationsEnabled === enabled) {
			return;
		}
		this.terminalColorSchemeNotificationsEnabled = enabled;
		if (!this.stopped) {
			this.terminal.write(enabled ? "\x1b[?2031h" : "\x1b[?2031l");
		}
	}

	private queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!getCapabilities().images) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	stop(options: TuiStopOptions = {}): void {
		this.stopped = true;
		// The hold itself belongs to the turn (interactive mode sets and releases it); a stop()/start() handover
		// for an external editor or a suspend in the middle of a turn must not drop it.
		this.#scrollbackStale = false;
		this.#scrollbackCatchUpPending = false;
		this.#muxViewportRepaintPending = false;
		this.renderRequested = false;
		this.inputRenderPending = false;
		this.cancelRenderTimer();
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031l");
		}
		this.beforeTerminalStop(options);
		this.resetMouseCaptureState();
		// Move cursor to the end of the content to prevent overwriting/artifacts on exit.
		// Skipped when the screen is preserved for another renderer taking over this terminal.
		if (!options.preserveScreen && this.previousLines.length > 0) {
			// Only overwrite the cursor cell when the last published frame kept the hardware cursor hidden;
			// a pending visibility change has not rendered yet and must not erase content.
			if (this.#lastCursorVisibility === false) {
				this.terminal.write(" ");
			}
			const targetRow = this.previousLines.length; // Line after the last content
			const lineDiff = targetRow - this.hardwareCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write("\r\n");
		}

		this.#lastCursorVisibility = undefined;
		this.#setCursorVisibility(true);
		if (process.env.TMUX) this.terminal.write(DISABLE_FOCUS_REPORTING);
		this.terminal.stop();
		this.afterTerminalStop(options);
		this.resetRenderState();
		this.#lastCursorVisibility = undefined;
		this.dropPreviousLines();
		this.previousKittyImageIds.clear();
		this.previousWidth = 0;
		this.previousHeight = 0;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
	}

	/**
	 * While a reply streams, a frame that changes rows above the viewport would replay the whole scrollback
	 * (ESC[3J and a full rewrite), which throws a user who scrolled up back to the top (#2836). With the hold
	 * on, such a frame repaints only the viewport and leaves the off-screen rows stale. The terminal cannot
	 * report its scroll position in main-screen mode, so the catch-up replay waits for a moment the user is
	 * surely at the bottom: their next keypress, or `catchUpScrollback()` (the next turn start).
	 */
	setScrollbackReplayHold(hold: boolean | "until-input"): void {
		this.#holdScrollbackReplay = hold !== false;
		this.#releaseHoldOnInput = hold === "until-input";
	}

	/** Replays the scrollback once if a held frame left rows above the viewport stale. */
	catchUpScrollback(): void {
		if (!this.#scrollbackStale) return;
		this.#scrollbackStale = false;
		this.#scrollbackCatchUpPending = true;
		this.requestRender();
	}

	renderNow(force = false): void {
		if (force) this.resetForcedRenderState();
		this.renderRequested = false;
		this.inputRenderPending = false;
		this.cancelRenderTimer();
		this.lastRenderAt = performance.now();
		this.doRender();
	}

	/** After stop(), the shell owns the cursor and it must stay visible, so only a running TUI hides it. */
	#setCursorVisibility(visible: boolean): void {
		if (!visible && this.stopped) return;
		if (this.#lastCursorVisibility === visible) return;
		if (visible) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
		this.#lastCursorVisibility = visible;
	}

	requestRender(force = false, source = "unknown"): void {
		if (force) {
			this.inputRenderPending = false;
			this.resetForcedRenderState();
			this.cancelRenderTimer();
			this.renderRequested = true;
			process.nextTick(() => {
				if (this.stopped || !this.renderRequested) {
					return;
				}
				this.renderRequested = false;
				this.lastRenderAt = performance.now();
				this.doRender();
			});
			return;
		}
		if (source === "input" || source === "editor.input") {
			if (!this.inputRenderPending) {
				this.inputRenderPending = true;
				this.renderRequested = true;
				process.nextTick(() => this.commitExpeditedRender());
			}
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	/**
	 * Cap the render scheduler at `fps` frames per second. Values are clamped
	 * to 30-120fps (120fps yields an 8ms minimum interval). Never calling this
	 * preserves the historic 16ms (~60fps) throttle.
	 */
	setMaxRenderFps(fps: number): void {
		const clamped = Math.min(120, Math.max(30, Math.round(fps)));
		this.#minRenderIntervalMs = Math.floor(1000 / clamped);
	}

	/** Drop every cached frame so the next render repaints from a clean slate. */
	private resetForcedRenderState(): void {
		this.#scrollbackCatchUpPending = false;
		this.resetRenderState();
		this.dropPreviousLines();
		this.previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
		this.previousHeight = -1; // -1 triggers heightChanged, forcing a full clear
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
	}

	private cancelRenderTimer(): void {
		if (!this.renderTimer) return;
		clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, this.#minRenderIntervalMs - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	private commitExpeditedRender(): void {
		if (!this.inputRenderPending) return;
		this.inputRenderPending = false;
		if (this.stopped || !this.renderRequested) {
			return;
		}
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		this.renderRequested = false;
		this.lastRenderAt = performance.now();
		this.doRender();
	}

	private handleTerminalInput(data: string): void {
		// Fullscreen renderers own focus events so they can clear only an active drag selection
		// without forcing idle or completed-selection repaints. Main-screen mode still uses focus
		// changes to refresh terminal capabilities after returning to a multiplexer pane.
		if (this.mode !== "fullscreen") {
			const focus = consumeTmuxFocusEvent(data);
			if (focus.event !== null) {
				if (this.shouldPreserveMuxScrollback()) {
					// senpi#1704: a forced render re-emitted the whole transcript into the pane's history on every
					// focus event. A pane losing focus is not visible, so it repaints nothing; a pane gaining focus
					// refreshes the terminal capabilities and repaints its viewport only.
					if (focus.event === "in") {
						resetCapabilitiesCache();
						this.invalidate();
						this.#muxViewportRepaintPending = true;
						this.requestRender();
					}
				} else {
					resetCapabilitiesCache();
					this.invalidate();
					this.requestRender(true);
				}
				if (focus.data.length === 0) return;
				data = focus.data;
			}
		}
		if (this.consumeTerminalColorResponse(data)) {
			return;
		}
		if (this.consumeTerminalColorSchemeReport(data)) {
			return;
		}
		// A key press means the user is at the bottom again. Terminal reports (mouse/wheel, OSC/DCS replies,
		// DEC private reports, window and cell-size reports) are not the user and must not trigger it.
		if (!isTerminalReport(data)) {
			if (this.#releaseHoldOnInput) {
				this.#releaseHoldOnInput = false;
				this.#holdScrollbackReplay = false;
			}
			this.catchUpScrollback();
		}

		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				this.setFocusInternal({ component: focusedOverlay.preFocus, overlayFocusRestore: "preserve" });
			}
		}

		const focusIsOverlay = this.overlayStack.some((o) => o.component === this.focusedComponent);
		if (!focusIsOverlay) {
			const restoreState = this.getVisibleOverlayFocusRestore();
			if (restoreState.status === "eligible") {
				this.setFocus(restoreState.overlay.component);
			} else if (restoreState.status === "blocked" && restoreState.blockedBy !== this.focusedComponent) {
				if (restoreState.resume.status === "restore-overlay") {
					this.setFocus(restoreState.overlay.component);
				} else {
					this.clearOverlayFocusRestore();
					this.setFocus(restoreState.resume.target);
				}
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			this.requestRender(false, "input");
		}
	}

	private consumeTerminalColorResponse(data: string): boolean {
		const query = this.pendingTerminalColorQueries[0];
		if (!query) {
			return false;
		}
		if (DEVICE_ATTRIBUTES_RESPONSE_PATTERN.test(data)) {
			this.pendingTerminalColorQueries.shift();
			this.completeTerminalColorQuery(query);
			return true;
		}

		const response = parseOscColorResponse(data);
		if (!response) {
			return false;
		}
		const { target, rgb } = response;
		const key = String(target);
		if (!query.deliver || query.replied.has(key)) {
			return true;
		}
		query.replied.add(key);
		if (target === "foreground") {
			query.foreground = rgb;
		} else if (target === "background") {
			query.background = rgb;
		} else if (target < TERMINAL_PALETTE_SIZE) {
			query.palette[target] = rgb;
		}
		if (query.replied.size === TERMINAL_COLOR_REPLY_COUNT) {
			this.completeTerminalColorQuery(query);
		}
		return true;
	}

	private terminalColorQueryResult(query: PendingTerminalColorQuery): TerminalColors {
		const palette = query.palette.every((color) => color !== undefined) ? (query.palette as RgbColor[]) : undefined;
		return { foreground: query.foreground, background: query.background, palette };
	}

	private completeTerminalColorQuery(query: PendingTerminalColorQuery): void {
		const deliver = query.deliver;
		query.deliver = undefined;
		clearTimeout(query.timer);
		deliver?.(this.terminalColorQueryResult(query));
	}

	private consumeTerminalColorSchemeReport(data: string): boolean {
		const scheme = parseTerminalColorSchemeReport(data);
		if (!scheme) {
			return false;
		}

		for (const listener of this.terminalColorSchemeListeners) {
			listener(scheme);
		}
		return true;
	}

	private consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
	protected compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) {
			this.renderedOverlayLayouts = [];
			return lines;
		}
		const result = [...lines];

		for (const entry of this.overlayStack) entry.bounds = undefined;

		// Pre-render all visible overlays and calculate positions
		const rendered: { entry: OverlayStackEntry; overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = component.render(width);

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
			entry.bounds = { row, col, width, height: overlayLines.length };

			rendered.push({ entry, overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}
		this.renderedOverlayLayouts = rendered.map(({ entry, row, col, w, overlayLines }) => ({
			entry,
			row,
			col,
			width: w,
			height: overlayLines.length,
		}));

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Composite each overlay
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		return result;
	}

	private static readonly SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";
	private static readonly NORMALIZE_MEMO_MIN = 4096;

	/**
	 * Every frame write is bracketed by synchronized output (DECSET 2026) and
	 * disables autowrap (DECAWM, DECRST 7) while rows are painted. Differential
	 * rendering tracks the cursor with relative moves only, so a row the
	 * terminal draws wider than visibleWidth() measured (East-Asian-ambiguous
	 * glyphs, emoji newer than the terminal's Unicode tables, decomposed jamo)
	 * would wrap, silently shift the cursor one row down, and leave stale ghost
	 * rows behind on every following diff. With autowrap off such rows clip at
	 * the last column instead. Autowrap is restored at frame end so the shell
	 * never observes the disabled state.
	 */
	private static readonly FRAME_BEGIN = "\x1b[?2026h\x1b[?7l";
	private static readonly FRAME_END = "\x1b[?7h\x1b[?2026l";

	private frameLineBytes = 0;

	private setPreviousLines(lines: string[], rawLines: string[]): void {
		const state = frameLineBytesState();
		state.bytes -= this.frameLineBytes;
		let bytes = lines.length * 8;
		for (const line of lines) bytes += line.length * 2;
		this.frameLineBytes = bytes;
		state.bytes += bytes;
		this.previousLines = lines;
		this.previousRawLines = rawLines;
	}

	/** Releases this TUI's frame from the process total (stop/dispose resets the frame). */
	private dropPreviousLines(): void {
		if (this.previousLines.length === 0 && this.previousRawLines.length === 0 && this.frameLineBytes === 0) return;
		this.setPreviousLines([], []);
	}

	/** Image presence of the committed frame, measured once per frame array instead of once per check. */
	protected previousLinesHaveImage(): boolean {
		const lines = this.previousLines;
		if (this.previousImageScan?.lines !== lines) {
			const hint = this.normalizedImageHint?.lines === lines ? this.normalizedImageHint.hasImage : undefined;
			this.previousImageScan = { lines, hasImage: hint ?? lines.some(isImageLine) };
		}
		return this.previousImageScan.hasImage;
	}

	/** Record image presence for a produced array; `undefined` leaves it to a scan when it is committed. */
	private hintNormalizedImages(lines: string[], hasImage: boolean | undefined): void {
		this.normalizedImageHint = hasImage === undefined ? undefined : { lines, hasImage };
	}

	private normalizeLine(line: string): { line: string; normalized: boolean } {
		if (isImageLine(line)) {
			return { line, normalized: false };
		}
		const cached = this.normalizeMemo.get(line);
		if (cached !== undefined) {
			return { line: cached, normalized: false };
		}
		const normalized = normalizeTerminalOutput(line) + TUI.SEGMENT_RESET;
		// The windowed path only ever adds: a long run of distinct lines (spinners, streamed text)
		// grew the memo without bound. Past a bound the oldest half goes; full passes rebuild it.
		if (this.normalizeMemo.size >= Math.max(TUI.NORMALIZE_MEMO_MIN, this.previousRawLines.length * 2)) {
			let drop = this.normalizeMemo.size >> 1;
			for (const key of this.normalizeMemo.keys()) {
				if (drop-- <= 0) break;
				this.normalizeMemo.delete(key);
			}
		}
		this.normalizeMemo.set(line, normalized);
		return { line: normalized, normalized: true };
	}

	protected applyLineResets(lines: string[]): string[] {
		return this.applyLineResetResult(lines).lines;
	}

	private applyLineResetResult(lines: string[], mode: "escaped" | "full" = "full"): NormalizedLinesResult {
		const previousMemo = this.normalizeMemo;
		const nextMemo = new Map<string, string>();
		const normalizedLines: string[] = [];
		let normalizedCount = 0;
		let hasImage = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (isImageLine(line)) {
				hasImage = true;
				normalizedLines.push(line);
				continue;
			}
			let normalized = nextMemo.get(line) ?? previousMemo.get(line);
			if (normalized === undefined) {
				normalized = normalizeTerminalOutput(line) + TUI.SEGMENT_RESET;
				normalizedCount += 1;
			}
			nextMemo.set(line, normalized);
			normalizedLines.push(normalized);
		}
		this.normalizeMemo = nextMemo;
		this.hintNormalizedImages(normalizedLines, hasImage);
		recordViewportRenderStats(normalizedCount, mode);
		return {
			lines: normalizedLines,
			firstRawChanged: 0,
			compareEndExclusive: normalizedLines.length,
			bounded: false,
		};
	}

	private applyViewportLineResets(
		rawLines: string[],
		viewportTop: number,
		height: number,
		stableDimensions: boolean,
	): NormalizedLinesResult {
		if (
			!viewportRenderEnabled() ||
			!stableDimensions ||
			this.previousLines.length === 0 ||
			this.previousRawLines.length !== this.previousLines.length
		) {
			return this.applyLineResetResult(rawLines);
		}
		if (this.previousRawLines.length !== rawLines.length) {
			return this.applyResizedLineResets(rawLines);
		}

		const windowStart = Math.max(0, viewportTop - VIEWPORT_RENDER_OVERSCAN);
		const windowEnd = Math.min(rawLines.length, viewportTop + height + VIEWPORT_RENDER_OVERSCAN);
		let firstRawChanged = -1;
		for (let i = 0; i < rawLines.length; i++) {
			if (rawLines[i] === this.previousRawLines[i]) {
				continue;
			}
			if (firstRawChanged === -1) {
				firstRawChanged = i;
			}
			if (i < windowStart || i >= windowEnd) {
				return this.applyLineResetResult(rawLines, "escaped");
			}
		}

		const previousHadImage = this.previousLinesHaveImage();
		const lines = this.previousLines.slice();
		let normalizedCount = 0;
		let changedImage = false;
		if (firstRawChanged !== -1) {
			for (let i = windowStart; i < windowEnd; i++) {
				if (rawLines[i] === this.previousRawLines[i]) {
					continue;
				}
				const raw = rawLines[i] ?? "";
				if (isImageLine(raw)) changedImage = true;
				const normalized = this.normalizeLine(raw);
				lines[i] = normalized.line;
				if (normalized.normalized) {
					normalizedCount += 1;
				}
			}
		}

		// A frame that had an image may have replaced it; only an image-free frame can be updated in place.
		this.hintNormalizedImages(lines, previousHadImage ? undefined : changedImage);
		recordViewportRenderStats(normalizedCount, "bounded");
		return {
			lines,
			firstRawChanged,
			compareEndExclusive: windowEnd,
			bounded: true,
		};
	}

	/**
	 * A frame whose line count changed (an append, a growing editor, a removed row) keeps every
	 * leading line that is unchanged since the last frame. Normalization is a pure function of the
	 * raw line, so the previous normalized prefix is reused and only the changed tail is normalized;
	 * the diff then starts where the raw lines first differ.
	 */
	private applyResizedLineResets(rawLines: string[]): NormalizedLinesResult {
		const previousRaw = this.previousRawLines;
		const sharedLength = Math.min(rawLines.length, previousRaw.length);
		let firstRawChanged = 0;
		while (firstRawChanged < sharedLength && rawLines[firstRawChanged] === previousRaw[firstRawChanged]) {
			firstRawChanged++;
		}
		const previousHadImage = this.previousLinesHaveImage();
		const lines = this.previousLines.slice(0, firstRawChanged);
		let normalizedCount = 0;
		let tailImage = false;
		for (let i = firstRawChanged; i < rawLines.length; i++) {
			const line = rawLines[i] ?? "";
			if (isImageLine(line)) {
				tailImage = true;
				lines.push(line);
				continue;
			}
			let normalized = this.normalizeMemo.get(line);
			if (normalized === undefined) {
				normalized = normalizeTerminalOutput(line) + TUI.SEGMENT_RESET;
				normalizedCount += 1;
			}
			lines.push(normalized);
		}
		this.hintNormalizedImages(lines, previousHadImage ? undefined : tailImage);
		recordViewportRenderStats(normalizedCount, "bounded");
		return {
			lines,
			firstRawChanged,
			compareEndExclusive: Math.max(rawLines.length, this.previousLines.length),
			bounded: true,
		};
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		recordKittyImageScanStats(lines.length);
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
		const rows = extractKittyImageRows(lines[index] ?? "");
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForKittyImages(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
	): { firstChanged: number; lastChanged: number } {
		let expandedFirstChanged = firstChanged;
		let expandedLastChanged = lastChanged;
		const expandForLines = (lines: string[]): void => {
			for (let i = 0; i < lines.length; i++) {
				if (extractKittyImageIds(lines[i]).length === 0) continue;
				const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
				if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		expandForLines(this.previousLines);
		expandForLines(newLines);
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
	}

	private changedRangeNeedsKittyImageExpansion(lines: string[], firstChanged: number, lastChanged: number): boolean {
		if (this.previousKittyImageIds.size > 0) {
			return true;
		}

		const start = Math.max(0, firstChanged);
		const end = Math.min(lines.length - 1, lastChanged);
		let scannedLines = 0;
		for (let i = start; i <= end; i++) {
			scannedLines += 1;
			const line = lines[i] ?? "";
			if (isImageLine(line) || extractKittyImageIds(line).length > 0) {
				recordKittyImageScanStats(scannedLines);
				return true;
			}
		}
		recordKittyImageScanStats(scannedLines);
		return false;
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	private getViewportRows(lines: string[], viewportTop: number, height: number): string[] {
		return Array.from({ length: height }, (_, row) => lines[viewportTop + row] ?? "");
	}

	private shouldPreserveMuxScrollback(): boolean {
		return this.#muxDetector() && !useLegacyMuxRender();
	}

	private createViewportInsertScrollPlan(
		newLines: string[],
		prevViewportTop: number,
		height: number,
		lineCountDelta: number,
	): ViewportInsertScrollPlan | undefined {
		if (lineCountDelta <= 0 || lineCountDelta >= height || this.overlayStack.length > 0) {
			return undefined;
		}

		const maxViewportTop = Math.max(0, newLines.length - height);
		const viewportTop = Math.min(maxViewportTop, prevViewportTop + lineCountDelta);
		if (viewportTop <= prevViewportTop) {
			return undefined;
		}

		const previousVisible = this.getViewportRows(this.previousLines, prevViewportTop, height);
		const nextVisible = this.getViewportRows(newLines, viewportTop, height);
		if (previousVisible.some(isImageLine) || nextVisible.some(isImageLine)) {
			return undefined;
		}

		let stableSuffixRows = 0;
		while (
			stableSuffixRows < height &&
			previousVisible[height - stableSuffixRows - 1] === nextVisible[height - stableSuffixRows - 1]
		) {
			stableSuffixRows += 1;
		}

		const regionHeight = height - stableSuffixRows;
		if (regionHeight <= 0 || regionHeight < lineCountDelta) {
			return undefined;
		}

		const mutatedRows: Array<{ screenRow: number; content: string }> = [];
		for (let row = 0; row < regionHeight - lineCountDelta; row++) {
			if (previousVisible[row + lineCountDelta] !== nextVisible[row]) {
				mutatedRows.push({ screenRow: row, content: nextVisible[row] });
				if (mutatedRows.length > MAX_SCROLL_DIFF_ROWS) {
					return undefined;
				}
			}
		}

		return {
			viewportTop,
			regionBottom: regionHeight - 1,
			insertedRows: nextVisible.slice(regionHeight - lineCountDelta, regionHeight),
			mutatedRows,
		};
	}

	private renderViewportInsertScroll(
		plan: ViewportInsertScrollPlan,
		newLines: string[],
		rawLines: string[],
		cursorPos: { row: number; col: number } | null,
		width: number,
		height: number,
	): void {
		let buffer = TUI.FRAME_BEGIN;
		const regionTop = 0;
		const regionBottom = plan.regionBottom;
		buffer += `\x1b[${regionTop + 1};${regionBottom + 1}r`;
		buffer += `\x1b[${regionBottom + 1};1H`;
		buffer += "\n".repeat(plan.insertedRows.length);
		buffer += "\x1b[r";

		const firstInsertedScreenRow = regionBottom - plan.insertedRows.length + 1;
		let finalPaintedScreenRow = firstInsertedScreenRow + plan.insertedRows.length - 1;
		for (let index = 0; index < plan.insertedRows.length; index++) {
			const screenRow = firstInsertedScreenRow + index;
			buffer += `\x1b[${screenRow + 1};1H\x1b[2K${TUI.SEGMENT_RESET}`;
			buffer += plan.insertedRows[index] ?? "";
		}
		for (const row of plan.mutatedRows) {
			buffer += `\x1b[${row.screenRow + 1};1H\x1b[2K${TUI.SEGMENT_RESET}`;
			buffer += row.content;
			finalPaintedScreenRow = row.screenRow;
		}

		const finalCursorRow = plan.viewportTop + finalPaintedScreenRow;
		buffer = this.finishFrame(buffer, cursorPos, newLines.length, finalCursorRow);
		writeBounded(this.terminal, buffer);

		this.cursorRow = Math.max(0, newLines.length - 1);
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = plan.viewportTop;
		this.setPreviousLines(newLines, rawLines);
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
		this.placementEpoch++;
	}

	private renderScrollbackReplay(
		newLines: string[],
		rawLines: string[],
		cursorPos: { row: number; col: number } | null,
		width: number,
		height: number,
		prevViewportTop: number,
		hardwareCursorRow: number,
	): void {
		this.#scrollbackStale = false;
		let buffer = TUI.FRAME_BEGIN;
		buffer += this.deleteKittyImages(this.previousKittyImageIds);
		if (!this.shouldPreserveMuxScrollback()) {
			buffer += "\x1b[3J";
		}

		const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
		if (currentScreenRow > 0) {
			buffer += `\x1b[${currentScreenRow}A`;
		}

		const bufferLength = Math.max(height, newLines.length);
		for (let row = 0; row < bufferLength; row++) {
			if (row > 0) buffer += "\r\n";
			buffer += `\r\x1b[2K${TUI.SEGMENT_RESET}`;
			buffer += newLines[row] ?? "";
		}

		buffer = this.finishFrame(buffer, cursorPos, newLines.length, bufferLength - 1);
		writeBounded(this.terminal, buffer);

		this.cursorRow = Math.max(0, newLines.length - 1);
		this.maxLinesRendered = newLines.length;
		this.previousViewportTop = Math.max(0, bufferLength - height);
		this.setPreviousLines(newLines, rawLines);
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
		this.placementEpoch++;
	}

	/**
	 * The held frame of `setScrollbackReplayHold` (#2836): rows above the old viewport stay as the terminal
	 * shows them (possibly stale), and the frame is rewritten from the old viewport top down. Rows the
	 * document grew by scroll naturally into scrollback in their current form, so nothing is lost there and
	 * nothing is cleared, and a reader who scrolled up keeps their place. Returns false when an image row is
	 * involved, so the caller replays as before.
	 */
	private renderHeldRepaint(
		newLines: string[],
		rawLines: string[],
		cursorPos: { row: number; col: number } | null,
		width: number,
		height: number,
		prevViewportTop: number,
		hardwareCursorRow: number,
	): boolean {
		const start = Math.min(prevViewportTop, Math.max(0, newLines.length - height));
		const rowCount = Math.max(height, newLines.length - start);
		const rows = Array.from({ length: rowCount }, (_, index) => newLines[start + index] ?? "");
		const previousVisible = this.getViewportRows(this.previousLines, prevViewportTop, height);
		if (rows.some(isImageLine) || previousVisible.some(isImageLine)) return false;

		let buffer = TUI.FRAME_BEGIN;
		const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
		if (currentScreenRow > 0) buffer += `\x1b[${currentScreenRow}A`;
		for (let row = 0; row < rows.length; row++) {
			if (row > 0) buffer += "\r\n";
			buffer += `\r\x1b[2K${TUI.SEGMENT_RESET}`;
			buffer += rows[row];
		}
		const lastRow = start + rows.length - 1;
		buffer = this.finishFrame(buffer, cursorPos, newLines.length, lastRow);
		writeBounded(this.terminal, buffer);

		this.#scrollbackStale = true;
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.maxLinesRendered = newLines.length;
		this.previousViewportTop = Math.max(0, lastRow + 1 - height);
		this.setPreviousLines(newLines, rawLines);
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
		this.placementEpoch++;
		return true;
	}

	private renderMuxViewportRepaint(
		newLines: string[],
		rawLines: string[],
		cursorPos: { row: number; col: number } | null,
		width: number,
		height: number,
		viewportTop = Math.max(0, newLines.length - height),
		home: "relative" | "absolute" = "relative",
	): boolean {
		const previousVisible = this.getViewportRows(this.previousLines, this.previousViewportTop, height);
		const nextVisible = this.getViewportRows(newLines, viewportTop, height);
		if (previousVisible.some(isImageLine) || nextVisible.some(isImageLine)) {
			return false;
		}

		let buffer = TUI.FRAME_BEGIN;
		if (home === "absolute") {
			buffer += "\x1b[H";
		} else {
			const currentScreenRow = Math.max(0, Math.min(height - 1, this.hardwareCursorRow - this.previousViewportTop));
			if (currentScreenRow > 0) {
				buffer += `\x1b[${currentScreenRow}A`;
			}
		}

		for (let row = 0; row < height; row++) {
			if (row > 0) buffer += "\r\n";
			buffer += `\r\x1b[2K${TUI.SEGMENT_RESET}`;
			buffer += newLines[viewportTop + row] ?? "";
		}

		const finalCursorRow = viewportTop + Math.max(0, height - 1);
		buffer = this.finishFrame(buffer, cursorPos, newLines.length, finalCursorRow);
		writeBounded(this.terminal, buffer);

		this.muxViewportRepaintCount += 1;
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.maxLinesRendered = newLines.length;
		this.previousViewportTop = viewportTop;
		this.setPreviousLines(newLines, rawLines);
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
		this.placementEpoch++;
		return true;
	}

	/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (isImageLine(baseLine) && visibleWidth(baseLine) === 0) return baseLine;
		const placeholderIndex = baseLine.indexOf("\u{10eeee}");
		const protocolEnd = placeholderIndex === -1 ? -1 : baseLine.lastIndexOf("\x1b\\", placeholderIndex);
		const protocolPrefix = protocolEnd === -1 ? "" : baseLine.slice(0, protocolEnd + 2);

		// Single pass through baseLine extracts both before and after segments
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// Pad segments to target widths
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// Compose result
		const r = TUI.SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// CRITICAL: Always verify and truncate to terminal width.
		// This is the final safeguard against width overflow which would crash the TUI.
		// Width tracking can drift from actual visible width due to:
		// - Complex ANSI/OSC sequences (hyperlinks, colors)
		// - Wide characters at segment boundaries
		// - Edge cases in segment extraction
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return protocolPrefix + result;
		}
		// Truncate with strict=true to ensure we don't exceed totalWidth
		return protocolPrefix + sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	protected extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				let afterMarker = line.slice(markerIndex + CURSOR_MARKER.length);
				if (this.showHardwareCursor && afterMarker.startsWith(FAKE_CURSOR_START)) {
					const fakeCursorEnd = afterMarker.indexOf(FAKE_CURSOR_END, FAKE_CURSOR_START.length);
					const fakeCursorReset = afterMarker.indexOf(FAKE_CURSOR_RESET, FAKE_CURSOR_START.length);
					if (fakeCursorReset !== -1 && (fakeCursorEnd === -1 || fakeCursorReset < fakeCursorEnd)) {
						// Keep a full reset because it may also terminate styles surrounding the fake cursor.
						afterMarker = afterMarker.slice(FAKE_CURSOR_START.length);
					} else if (fakeCursorEnd !== -1) {
						afterMarker =
							afterMarker.slice(FAKE_CURSOR_START.length, fakeCursorEnd) +
							afterMarker.slice(fakeCursorEnd + FAKE_CURSOR_END.length);
					}
				}

				// Strip marker and any colocated fake cursor styling when the hardware cursor owns the position.
				lines[row] = beforeMarker + afterMarker;

				return { row, col };
			}
		}
		return null;
	}

	protected doRender(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		if (widthChanged || heightChanged) this.placementEpoch++;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render all components to get new lines. The main screen tells containers which rows of the
		// last frame are in native scrollback, so live content there can stay as the terminal shows it.
		renderFrame.scrollbackRows =
			this.mode === "regular" && !widthChanged && !heightChanged && this.previousLines.length > 0
				? prevViewportTop
				: 0;
		renderFrame.mode = this.mode;
		renderFrame.rows = height;
		let newLines: string[];
		try {
			newLines = renderAtFrameRow(this, width, 0);
		} finally {
			renderFrame.scrollbackRows = 0;
			renderFrame.mode = undefined;
		}

		// Composite overlays into the rendered lines (before differential compare)
		if (this.overlayStack.length > 0) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		const rawLines = newLines;
		const normalizedLines = this.applyViewportLineResets(
			rawLines,
			prevViewportTop,
			height,
			!widthChanged && !heightChanged,
		);
		newLines = normalizedLines.lines;
		const preserveMuxScrollback = this.shouldPreserveMuxScrollback();

		if (this.#scrollbackCatchUpPending) {
			this.#scrollbackCatchUpPending = false;
			if (!preserveMuxScrollback && !widthChanged && !heightChanged) {
				this.renderScrollbackReplay(
					newLines,
					rawLines,
					cursorPos,
					width,
					height,
					prevViewportTop,
					hardwareCursorRow,
				);
				return;
			}
			// A resize frame takes its own path below; if that path does not rewrite the scrollback, the
			// rows are still stale and the next key press catches up.
			if (!preserveMuxScrollback) this.#scrollbackStale = true;
		}

		// Helper to clear scrollback and viewport and render all new lines
		const fullRender = (clear: boolean, clearScrollback = clear): void => {
			this.fullRedrawCount += 1;
			let buffer = TUI.FRAME_BEGIN;
			if (clear) {
				if (clearScrollback) this.#scrollbackStale = false;
				buffer += this.deleteKittyImages(this.previousKittyImageIds);
				buffer += "\x1b[2J\x1b[H";
				if (clearScrollback && !preserveMuxScrollback && process.platform !== "win32") {
					buffer += "\x1b[3J";
				}
			} else {
				buffer += `\r\x1b[2K${TUI.SEGMENT_RESET}`;
			}
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				const line = newLines[i];
				const isImage = isImageLine(line);
				const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i) : 1;
				if (imageReservedRows > 1 && imageReservedRows <= height) {
					for (let row = 1; row < imageReservedRows; row++) {
						buffer += "\r\n";
					}
					buffer += `\x1b[${imageReservedRows - 1}A`;
					buffer += line;
					buffer += `\x1b[${imageReservedRows - 1}B`;
					i += imageReservedRows - 1;
					continue;
				}
				buffer += line;
			}
			const finalCursorRow = Math.max(0, newLines.length - 1);
			buffer = this.finishFrame(buffer, cursorPos, newLines.length, finalCursorRow);
			writeBounded(this.terminal, buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.setPreviousLines(newLines, rawLines);
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.noteFullRender(clear);
		};

		const debugRedraw = process.env.PI_DEBUG_REDRAW === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const logPath = path.join(this.logDirectory, "pi-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			fs.appendFileSync(logPath, msg, { encoding: "utf8", mode: DIAGNOSTIC_LOG_MODE });
			chmodDiagnosticLogBestEffort(logPath);
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			// A width change (or a forced render) repaints everything below; a focus repaint queued in the
			// same tick is satisfied by it.
			this.#muxViewportRepaintPending = false;
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			// In a multiplexer only the re-wrapped viewport is repainted: re-emitting every line of the buffer scrolled a
			// copy of the whole transcript into the pane's history on each width change (senpi#1704). Rows already in
			// that history keep their old wrapping. The pane re-wrapped the screen itself, so the repaint homes there.
			if (preserveMuxScrollback && this.previousWidth > 0) {
				if (this.renderMuxViewportRepaint(newLines, rawLines, cursorPos, width, height, undefined, "absolute"))
					return;
			}
			fullRender(true, !preserveMuxScrollback);
			return;
		}

		if (this.#muxViewportRepaintPending) {
			this.#muxViewportRepaintPending = false;
			if (preserveMuxScrollback && !heightChanged) {
				logRedraw("multiplexer pane focus regained");
				// A frame queued before the focus event may have grown the content: follow it exactly as an
				// ordinary frame does, so rows added below (the editor, the status line) stay on screen.
				// After a shrink the viewport keeps its top (as the deleted-lines path does), so the repaint does
				// not scroll rows already in the pane's history into view a second time.
				const focusViewportTop =
					newLines.length > prevViewportTop
						? Math.max(prevViewportTop, newLines.length - height)
						: Math.max(0, newLines.length - height);
				if (!this.renderMuxViewportRepaint(newLines, rawLines, cursorPos, width, height, focusViewportTop)) {
					fullRender(true, false);
				}
				return;
			}
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			if (preserveMuxScrollback) {
				if (!this.renderMuxViewportRepaint(newLines, rawLines, cursorPos, width, height)) {
					fullRender(true, false);
				}
			} else {
				fullRender(true);
			}
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or PI_CLEAR_ON_SHRINK=0 env var
		if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true, !preserveMuxScrollback);
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		const diffScanStart =
			normalizedLines.bounded && normalizedLines.firstRawChanged !== -1 ? normalizedLines.firstRawChanged : 0;
		const diffScanEndExclusive = normalizedLines.bounded ? normalizedLines.compareEndExclusive : maxLines;
		for (let i = diffScanStart; i < diffScanEndExclusive; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		const lineCountDelta = newLines.length - this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		const needsKittyImageExpansion =
			firstChanged !== -1 && this.changedRangeNeedsKittyImageExpansion(newLines, firstChanged, lastChanged);
		if (needsKittyImageExpansion) {
			const expandedRange = this.expandChangedRangeForKittyImages(firstChanged, lastChanged, newLines);
			firstChanged = expandedRange.firstChanged;
			lastChanged = expandedRange.lastChanged;
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;
		const insertScrollPlan = this.createViewportInsertScrollPlan(newLines, prevViewportTop, height, lineCountDelta);

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			return;
		}

		if (insertScrollPlan) {
			this.renderViewportInsertScroll(insertScrollPlan, newLines, rawLines, cursorPos, width, height);
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				let buffer = TUI.FRAME_BEGIN;
				buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender(true, !preserveMuxScrollback);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true, !preserveMuxScrollback);
					return;
				}
				const clearStartOffset = newLines.length === 0 ? 0 : 1;
				if (extraLines > 0 && clearStartOffset > 0) {
					buffer += `\x1b[${clearStartOffset}B`;
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += `\r\x1b[2K${TUI.SEGMENT_RESET}`;
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
				if (moveBack > 0) {
					buffer += `\x1b[${moveBack}A`;
				}
				buffer = this.finishFrame(buffer, cursorPos, newLines.length, targetRow);
				writeBounded(this.terminal, buffer);
				this.cursorRow = targetRow;
			} else {
				this.positionHardwareCursor(cursorPos, newLines.length);
			}
			this.setPreviousLines(newLines, rawLines);
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			return;
		}

		// Differential rendering can only touch what was actually visible.
		if (firstChanged < prevViewportTop) {
			if (newLines.length < this.previousLines.length) {
				viewportTop = Math.max(0, newLines.length - height);
			}

			if (newLines.length > this.previousLines.length) {
				const maxViewportTop = Math.max(0, newLines.length - height);
				viewportTop = Math.min(maxViewportTop, prevViewportTop + lineCountDelta);
			}

			let firstVisibleChanged = -1;
			let lastVisibleChanged = -1;
			for (let row = 0; row < height; row++) {
				const previousLine = this.previousLines[prevViewportTop + row] ?? "";
				const nextLine = newLines[viewportTop + row] ?? "";
				if (previousLine !== nextLine) {
					if (firstVisibleChanged === -1) {
						firstVisibleChanged = row;
					}
					lastVisibleChanged = row;
				}
			}

			if (firstVisibleChanged === -1) {
				if (lineCountDelta !== 0) {
					if (preserveMuxScrollback) {
						// Above-viewport scrollback may stay stale in mux panes; only the visible viewport is repainted.
						if (!this.renderMuxViewportRepaint(newLines, rawLines, cursorPos, width, height, viewportTop)) {
							fullRender(true, false);
						}
					} else if (
						this.#holdScrollbackReplay &&
						this.renderHeldRepaint(
							newLines,
							rawLines,
							cursorPos,
							width,
							height,
							prevViewportTop,
							hardwareCursorRow,
						)
					) {
						// Held: rows above the old viewport stay stale until the catch-up replay.
					} else {
						this.renderScrollbackReplay(
							newLines,
							rawLines,
							cursorPos,
							width,
							height,
							prevViewportTop,
							hardwareCursorRow,
						);
					}
					return;
				}

				this.cursorRow = Math.max(0, newLines.length - 1);
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
				this.setPreviousLines(newLines, rawLines);
				this.previousWidth = width;
				this.previousHeight = height;
				this.previousViewportTop = viewportTop;
				return;
			}

			if (viewportTop !== prevViewportTop) {
				// Content grew above the viewport (e.g. Ctrl+O expanding several tool
				// blocks at once). Repainting only the visible rows would drop the
				// inserted above-viewport rows from scrollback while marking them painted,
				// so fall back to the canonical replay / mux dispatch used by the
				// firstVisibleChanged === -1 path, which re-emits the full transcript.
				if (lineCountDelta !== 0) {
					if (preserveMuxScrollback) {
						if (!this.renderMuxViewportRepaint(newLines, rawLines, cursorPos, width, height, viewportTop)) {
							fullRender(true, false);
						}
					} else if (
						this.#holdScrollbackReplay &&
						this.renderHeldRepaint(
							newLines,
							rawLines,
							cursorPos,
							width,
							height,
							prevViewportTop,
							hardwareCursorRow,
						)
					) {
						// Held: rows above the old viewport stay stale until the catch-up replay.
					} else {
						this.renderScrollbackReplay(
							newLines,
							rawLines,
							cursorPos,
							width,
							height,
							prevViewportTop,
							hardwareCursorRow,
						);
					}
					return;
				}

				const previousViewportBottom = Math.min(this.previousLines.length - 1, prevViewportTop + height - 1);
				let buffer = TUI.FRAME_BEGIN;
				buffer += this.deleteChangedKittyImages(prevViewportTop, previousViewportBottom);

				const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
				if (currentScreenRow > 0) {
					buffer += `\x1b[${currentScreenRow}A`;
				}

				for (let row = 0; row < height; row++) {
					if (row > 0) buffer += "\r\n";
					buffer += `\r\x1b[2K${TUI.SEGMENT_RESET}`;
					buffer += newLines[viewportTop + row] ?? "";
				}

				const finalCursorRow = viewportTop + Math.max(0, height - 1);
				buffer = this.finishFrame(buffer, cursorPos, newLines.length, finalCursorRow);
				writeBounded(this.terminal, buffer);

				this.cursorRow = Math.max(0, newLines.length - 1);
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
				this.previousViewportTop = viewportTop;
				this.setPreviousLines(newLines, rawLines);
				this.previousKittyImageIds = this.collectKittyImageIds(newLines);
				this.previousWidth = width;
				this.previousHeight = height;
				return;
			}

			firstChanged = viewportTop + firstVisibleChanged;
			lastChanged = Math.min(newLines.length - 1, viewportTop + lastVisibleChanged);
		}

		// Render from first changed line to end
		// Build buffer with all updates wrapped in synchronized output
		let buffer = TUI.FRAME_BEGIN;
		buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			const line = newLines[i];
			const isImage = isImageLine(line);
			const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;
			if (imageReservedRows > 1) {
				const imageStartScreenRow = i - viewportTop;
				if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
					logRedraw(
						`kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`,
					);
					fullRender(true, !preserveMuxScrollback);
					return;
				}

				buffer += `\x1b[2K${TUI.SEGMENT_RESET}`;
				for (let row = 1; row < imageReservedRows; row++) {
					buffer += `\r\n\x1b[2K${TUI.SEGMENT_RESET}`;
				}
				buffer += `\x1b[${imageReservedRows - 1}A`;
				buffer += line;
				buffer += `\x1b[${imageReservedRows - 1}B`;
				i += imageReservedRows - 1;
				continue;
			}

			buffer += `\x1b[2K${TUI.SEGMENT_RESET}`; // Clear current line
			const lineWidth = visibleWidth(line);
			if (!isImage && lineWidth > width) {
				const crashLogPath = path.join(os.homedir(), ".senpi", "agent", "senpi-crash.log");
				const strictRender = process.env.PI_TUI_STRICT_RENDER === "1";
				if (strictRender || !this.overWideCrashDumpWritten) {
					const crashData = formatOverWideRenderDiagnostic(newLines, width, i, lineWidth);
					if (!strictRender) {
						writeRenderDiagnosticBestEffort(crashLogPath, crashData);
						this.overWideCrashDumpWritten = true;
					} else {
						const crashDumpWritten = writeRenderDiagnosticBestEffort(crashLogPath, crashData);

						// Clean up terminal state before throwing
						this.stop();

						const errorMsg = [
							`Rendered line ${i} exceeds terminal width (${lineWidth} > ${width}).`,
							"",
							"This is likely caused by a custom TUI component not truncating its output.",
							"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
							"",
							crashDumpWritten
								? `Debug log written to: ${crashLogPath}`
								: `Debug log could not be written to: ${crashLogPath}`,
						].join("\n");
						throw new Error(errorMsg);
					}
				}
				const truncatedLine = sliceByColumn(line, 0, width, true) + TUI.SEGMENT_RESET;
				newLines[i] = truncatedLine;
				buffer += truncatedLine;
				continue;
			}
			buffer += line;
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += `\r\n\x1b[2K${TUI.SEGMENT_RESET}`;
			}
			// Move cursor back to end of new content
			buffer += `\x1b[${extraLines}A`;
		}

		buffer = this.finishFrame(buffer, cursorPos, newLines.length, finalCursorRow);

		if (process.env.PI_TUI_DEBUG === "1") {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				JSON.stringify(buffer),
			].join("\n");
			fs.writeFileSync(debugPath, debugData, { encoding: "utf8", mode: DIAGNOSTIC_LOG_MODE });
			chmodDiagnosticLogBestEffort(debugPath);
		}

		// Write entire buffer at once
		writeBounded(this.terminal, buffer);

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		this.setPreviousLines(newLines, rawLines);
		if (needsKittyImageExpansion) {
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		}
		this.previousWidth = width;
		this.previousHeight = height;
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private buildHardwareCursorSequence(cursorPos: { row: number; col: number } | null, totalLines: number): string {
		let buffer = "";
		if (!cursorPos || totalLines <= 0) {
			if (this.#lastCursorVisibility !== false) {
				buffer += "\x1b[?25l";
				this.#lastCursorVisibility = false;
			}
		} else {
			// Clamp cursor position to valid range
			const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
			const targetCol = Math.max(0, cursorPos.col);

			// Move cursor from current position to target
			const rowDelta = targetRow - this.hardwareCursorRow;
			if (rowDelta > 0) {
				buffer += `\x1b[${rowDelta}B`; // Move down
			} else if (rowDelta < 0) {
				buffer += `\x1b[${-rowDelta}A`; // Move up
			}
			// Move to absolute column (1-indexed)
			buffer += `\x1b[${targetCol + 1}G`;

			this.hardwareCursorRow = targetRow;
			if (this.#lastCursorVisibility !== this.showHardwareCursor) {
				buffer += this.showHardwareCursor ? "\x1b[?25h" : "\x1b[?25l";
				this.#lastCursorVisibility = this.showHardwareCursor;
			}
		}

		return buffer;
	}

	private finishFrame(
		buffer: string,
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
		hardwareCursorRow: number,
	): string {
		this.hardwareCursorRow = hardwareCursorRow;
		return buffer + this.buildHardwareCursorSequence(cursorPos, totalLines) + TUI.FRAME_END;
	}

	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		const buffer = this.buildHardwareCursorSequence(cursorPos, totalLines);
		if (buffer) this.terminal.write(TUI.FRAME_BEGIN + buffer + TUI.FRAME_END);
	}

	/**
	 * Query the terminal's theme colors: the default foreground (OSC 10), the default background
	 * (OSC 11), and ANSI colors 0-15 (OSC 4), followed by a DA1 request that marks the end of the
	 * replies. Resolves when the DA1 reply or all color replies arrive, or when the timeout expires.
	 * Colors the terminal did not report are undefined; the palette is only set when all 16 arrived.
	 * @param timeoutMs Query timeout in milliseconds, for terminals that do not answer DA1 either.
	 * @param onLateReply Receives the replies if the query completes after the timeout, e.g. over slow links.
	 */
	queryTerminalColors({
		timeoutMs,
		onLateReply,
	}: {
		timeoutMs: number;
		onLateReply?: (colors: TerminalColors) => void;
	}): Promise<TerminalColors> {
		return new Promise((resolve) => {
			const query: PendingTerminalColorQuery = {
				palette: Array.from({ length: TERMINAL_PALETTE_SIZE }, () => undefined),
				replied: new Set(),
				deliver: resolve,
				timer: undefined,
			};
			// Resolve with the replies so far, and keep collecting late replies for `onLateReply`.
			query.timer = setTimeout(() => {
				query.deliver = onLateReply;
				resolve(this.terminalColorQueryResult(query));
			}, timeoutMs);
			this.pendingTerminalColorQueries.push(query);
			this.terminal.write(TERMINAL_COLOR_QUERY);
		});
	}
}

/**
 * Input that the terminal sends on its own rather than the user typing: mouse reports, OSC/DCS/APC
 * replies, DEC private reports (`ESC[?...`) and window/cell-size reports (`ESC[...t`). OSC/DCS/APC need
 * a body after the introducer, so a legacy Alt+] / Alt+Shift+P / Alt+_ key press is still a key.
 */
function isTerminalReport(data: string): boolean {
	return (
		data.startsWith("\x1b[<") ||
		data.startsWith("\x1b[M") ||
		(data.length > 2 && (data.startsWith("\x1b]") || data.startsWith("\x1bP") || data.startsWith("\x1b_"))) ||
		data.startsWith("\x1b[?") ||
		/^\x1b\[\d+(;\d+)*t$/.test(data)
	);
}

/** Legacy main-screen renderer export. */
export class TUI extends TuiBase {
	readonly mode: TuiMode = "regular";
}
