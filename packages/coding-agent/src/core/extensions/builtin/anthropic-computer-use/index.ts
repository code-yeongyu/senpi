import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Api, TextContent } from "@mariozechner/pi-ai";
import { type Static, Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "../../types.js";

const execFileAsync = promisify(execFile);

type ToolDefinition = Record<string, unknown>;

const ANTHROPIC_COMPUTER_USE_ENV = "PI_ANTHROPIC_COMPUTER_USE";
const ANTHROPIC_COMPUTER_USE_WIDTH_ENV = "PI_ANTHROPIC_COMPUTER_USE_WIDTH";
const ANTHROPIC_COMPUTER_USE_HEIGHT_ENV = "PI_ANTHROPIC_COMPUTER_USE_HEIGHT";
const ANTHROPIC_COMPUTER_USE_DISPLAY_NUMBER_ENV = "PI_ANTHROPIC_COMPUTER_USE_DISPLAY_NUMBER";
const ANTHROPIC_COMPUTER_USE_BETA = "computer-use-2025-01-24";

const ANTHROPIC_NATIVE_COMPUTER_TOOL_TYPE = "computer_20250124";
const ANTHROPIC_NATIVE_COMPUTER_TOOL_NAME = "computer";

export const computerSchema = Type.Object({
	action: Type.Union([
		Type.Literal("screenshot"),
		Type.Literal("key"),
		Type.Literal("type"),
		Type.Literal("mouse_move"),
		Type.Literal("left_click"),
		Type.Literal("right_click"),
		Type.Literal("middle_click"),
		Type.Literal("double_click"),
		Type.Literal("triple_click"),
		Type.Literal("left_click_drag"),
		Type.Literal("cursor_position"),
		Type.Literal("left_mouse_down"),
		Type.Literal("left_mouse_up"),
		Type.Literal("scroll"),
		Type.Literal("hold_key"),
		Type.Literal("wait"),
	]),
	coordinate: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
	start_coordinate: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
	text: Type.Optional(Type.String()),
	key: Type.Optional(Type.String()),
	scroll_direction: Type.Optional(
		Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
	),
	scroll_amount: Type.Optional(Type.Number()),
	duration: Type.Optional(Type.Number()),
});

export type ComputerToolInput = Static<typeof computerSchema>;

export type ComputerResult = {
	content: Array<
		| TextContent
		| {
				type: "image";
				data: string;
				mimeType: "image/png";
		  }
	>;
	isError?: boolean;
};

export interface ComputerOperations {
	screenshot(): Promise<{ base64: string }>;
	cursorPosition(): Promise<{ x: number; y: number }>;
	mouseMove(x: number, y: number): Promise<void>;
	click(button: "left" | "right" | "middle", x?: number, y?: number, modifier?: string): Promise<void>;
	doubleClick(x?: number, y?: number): Promise<void>;
	tripleClick(x?: number, y?: number): Promise<void>;
	drag(startX: number, startY: number, endX: number, endY: number): Promise<void>;
	mouseDown(button: "left", x?: number, y?: number): Promise<void>;
	mouseUp(button: "left", x?: number, y?: number): Promise<void>;
	scroll(
		direction: "up" | "down" | "left" | "right",
		amount: number,
		x?: number,
		y?: number,
		modifier?: string,
	): Promise<void>;
	keyPress(combo: string): Promise<void>;
	type(text: string): Promise<void>;
	holdKey(combo: string, durationSec: number): Promise<void>;
	wait(durationSec: number): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function enabledByEnv(env: string | undefined): boolean {
	if (!env) {
		return false;
	}
	const normalized = env.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parsePositiveInt(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		return undefined;
	}
	const parsed = Number.parseInt(trimmed, 10);
	return parsed > 0 ? parsed : undefined;
}

function getComputerDisplayConfig(): { width: number; height: number; displayNumber?: number } | undefined {
	const width = parsePositiveInt(process.env[ANTHROPIC_COMPUTER_USE_WIDTH_ENV]);
	const height = parsePositiveInt(process.env[ANTHROPIC_COMPUTER_USE_HEIGHT_ENV]);
	const displayNumber = parsePositiveInt(process.env[ANTHROPIC_COMPUTER_USE_DISPLAY_NUMBER_ENV]);
	if (width === undefined || height === undefined) {
		return undefined;
	}
	if (displayNumber === undefined) {
		return { width, height };
	}
	return { width, height, displayNumber };
}

function getComputerEnableState(): {
	enabled: boolean;
	config?: { width: number; height: number; displayNumber?: number };
} {
	if (!enabledByEnv(process.env[ANTHROPIC_COMPUTER_USE_ENV])) {
		return { enabled: false };
	}
	const config = getComputerDisplayConfig();
	if (!config) {
		return { enabled: false };
	}
	return { enabled: true, config };
}

export function isAnthropicComputerUseEnabled(): boolean {
	return getComputerEnableState().enabled;
}

function isComputerToolType(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("computer_");
}

function sanitizeTools(tools: unknown[]): ToolDefinition[] {
	const sanitizedTools: ToolDefinition[] = [];
	for (const tool of tools) {
		if (!isRecord(tool)) {
			continue;
		}
		const shouldStripFunctionVariant =
			tool.name === ANTHROPIC_NATIVE_COMPUTER_TOOL_NAME && !isComputerToolType(tool.type);
		if (!shouldStripFunctionVariant) {
			sanitizedTools.push(tool);
		}
	}
	return sanitizedTools;
}

function mergeBetaHeader(existing: unknown): string {
	const existingParts =
		typeof existing === "string"
			? existing
					.split(",")
					.map((part) => part.trim())
					.filter(Boolean)
			: [];
	if (existingParts.includes(ANTHROPIC_COMPUTER_USE_BETA)) {
		return existingParts.join(",");
	}
	return [...existingParts, ANTHROPIC_COMPUTER_USE_BETA].join(",");
}

export function addAnthropicComputerUseToPayload(api: Api | undefined, payload: unknown): unknown {
	if (api !== "anthropic-messages") {
		return payload;
	}
	const state = getComputerEnableState();
	if (!state.enabled || !state.config) {
		return payload;
	}
	if (!isRecord(payload)) {
		return payload;
	}

	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const sanitizedTools = sanitizeTools(tools);
	const hasNativeComputer = sanitizedTools.some((tool) => isComputerToolType(tool.type));
	if (!hasNativeComputer) {
		sanitizedTools.push({
			type: ANTHROPIC_NATIVE_COMPUTER_TOOL_TYPE,
			name: ANTHROPIC_NATIVE_COMPUTER_TOOL_NAME,
			display_width_px: state.config.width,
			display_height_px: state.config.height,
			...(state.config.displayNumber !== undefined ? { display_number: state.config.displayNumber } : {}),
		});
	}

	const existingBetas = isRecord(payload.extra_body) ? payload.extra_body.betas : undefined;
	const mergedBetas = Array.isArray(existingBetas)
		? existingBetas.includes(ANTHROPIC_COMPUTER_USE_BETA)
			? existingBetas
			: [...existingBetas, ANTHROPIC_COMPUTER_USE_BETA]
		: [ANTHROPIC_COMPUTER_USE_BETA];

	const headers = isRecord(payload.headers) ? payload.headers : {};
	const nextHeaders = {
		...headers,
		"anthropic-beta": mergeBetaHeader(headers["anthropic-beta"]),
	};

	return {
		...payload,
		tools: sanitizedTools,
		headers: nextHeaders,
		extra_body: {
			...(isRecord(payload.extra_body) ? payload.extra_body : {}),
			betas: mergedBetas,
		},
	};
}

function imageResult(base64: string): ComputerResult {
	return {
		content: [
			{
				type: "image",
				data: base64,
				mimeType: "image/png",
			},
		],
	};
}

function errorResult(message: string): ComputerResult {
	return {
		isError: true,
		content: [{ type: "text", text: message }],
	};
}

function parseCoordinate(coordinate: number[] | undefined, action: string): [number, number] {
	if (!coordinate || coordinate.length !== 2) {
		throw new Error(`${action} requires coordinate [x, y]`);
	}
	return [coordinate[0] ?? 0, coordinate[1] ?? 0];
}

function parseDuration(duration: number | undefined, action: string): number {
	if (duration === undefined || Number.isNaN(duration) || duration < 0) {
		throw new Error(`${action} requires duration >= 0`);
	}
	return duration;
}

function parseText(text: string | undefined, action: string): string {
	if (!text) {
		throw new Error(`${action} requires text`);
	}
	return text;
}

export async function executeComputerAction(
	input: ComputerToolInput,
	ops: ComputerOperations,
): Promise<ComputerResult> {
	try {
		switch (input.action) {
			case "screenshot": {
				const screenshot = await ops.screenshot();
				return imageResult(screenshot.base64);
			}
			case "key": {
				const combo = parseText(input.text ?? input.key, "key");
				await ops.keyPress(combo);
				break;
			}
			case "type": {
				await ops.type(parseText(input.text, "type"));
				break;
			}
			case "mouse_move": {
				const [x, y] = parseCoordinate(input.coordinate, "mouse_move");
				await ops.mouseMove(x, y);
				break;
			}
			case "left_click": {
				const coordinate = input.coordinate;
				if (coordinate) {
					const [x, y] = parseCoordinate(coordinate, "left_click");
					await ops.click("left", x, y);
				} else {
					await ops.click("left");
				}
				break;
			}
			case "right_click": {
				const coordinate = input.coordinate;
				if (coordinate) {
					const [x, y] = parseCoordinate(coordinate, "right_click");
					await ops.click("right", x, y);
				} else {
					await ops.click("right");
				}
				break;
			}
			case "middle_click": {
				const coordinate = input.coordinate;
				if (coordinate) {
					const [x, y] = parseCoordinate(coordinate, "middle_click");
					await ops.click("middle", x, y);
				} else {
					await ops.click("middle");
				}
				break;
			}
			case "double_click": {
				const coordinate = input.coordinate;
				if (coordinate) {
					const [x, y] = parseCoordinate(coordinate, "double_click");
					await ops.doubleClick(x, y);
				} else {
					await ops.doubleClick();
				}
				break;
			}
			case "triple_click": {
				const coordinate = input.coordinate;
				if (coordinate) {
					const [x, y] = parseCoordinate(coordinate, "triple_click");
					await ops.tripleClick(x, y);
				} else {
					await ops.tripleClick();
				}
				break;
			}
			case "left_click_drag": {
				const [startX, startY] = parseCoordinate(input.start_coordinate, "left_click_drag.start_coordinate");
				const [endX, endY] = parseCoordinate(input.coordinate, "left_click_drag.coordinate");
				await ops.drag(startX, startY, endX, endY);
				break;
			}
			case "cursor_position": {
				const position = await ops.cursorPosition();
				return { content: [{ type: "text", text: `X=${position.x},Y=${position.y}` }] };
			}
			case "left_mouse_down": {
				const coordinate = input.coordinate;
				if (coordinate) {
					const [x, y] = parseCoordinate(coordinate, "left_mouse_down");
					await ops.mouseDown("left", x, y);
				} else {
					await ops.mouseDown("left");
				}
				break;
			}
			case "left_mouse_up": {
				const coordinate = input.coordinate;
				if (coordinate) {
					const [x, y] = parseCoordinate(coordinate, "left_mouse_up");
					await ops.mouseUp("left", x, y);
				} else {
					await ops.mouseUp("left");
				}
				break;
			}
			case "scroll": {
				if (!input.scroll_direction) {
					throw new Error("scroll requires scroll_direction");
				}
				if (input.scroll_amount === undefined || input.scroll_amount <= 0) {
					throw new Error("scroll requires positive scroll_amount");
				}
				const coordinate = input.coordinate;
				if (coordinate) {
					const [x, y] = parseCoordinate(coordinate, "scroll");
					await ops.scroll(input.scroll_direction, input.scroll_amount, x, y);
				} else {
					await ops.scroll(input.scroll_direction, input.scroll_amount);
				}
				break;
			}
			case "hold_key": {
				await ops.holdKey(
					parseText(input.text ?? input.key, "hold_key"),
					parseDuration(input.duration, "hold_key"),
				);
				break;
			}
			case "wait": {
				await ops.wait(parseDuration(input.duration, "wait"));
				break;
			}
		}

		const screenshot = await ops.screenshot();
		return imageResult(screenshot.base64);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return errorResult(message);
	}
}

async function commandExists(command: string): Promise<boolean> {
	try {
		await execFileAsync("which", [command]);
		return true;
	} catch {
		return false;
	}
}

async function run(command: string, args: string[]): Promise<string> {
	const result = await execFileAsync(command, args);
	return result.stdout;
}

function parseKeyComboToAppleScript(combo: string): string {
	const parts = combo
		.split("+")
		.map((part) => part.trim().toLowerCase())
		.filter(Boolean);
	if (parts.length === 0) {
		throw new Error("Empty key combo");
	}
	const main = parts[parts.length - 1] ?? "";
	const modifiers = new Set(parts.slice(0, -1));
	const usingParts: string[] = [];
	if (modifiers.has("ctrl") || modifiers.has("control")) usingParts.push("control down");
	if (modifiers.has("cmd") || modifiers.has("command")) usingParts.push("command down");
	if (modifiers.has("alt") || modifiers.has("option")) usingParts.push("option down");
	if (modifiers.has("shift")) usingParts.push("shift down");
	const targetKey = main.length === 1 ? `keystroke ${JSON.stringify(main)}` : `key code ${mapKeyCode(main)}`;
	if (usingParts.length === 0) {
		return `tell application "System Events" to ${targetKey}`;
	}
	return `tell application "System Events" to ${targetKey} using {${usingParts.join(", ")}}`;
}

function mapKeyCode(key: string): number {
	const map: Record<string, number> = { enter: 36, return: 36, tab: 48, space: 49, esc: 53, escape: 53 };
	const code = map[key];
	if (code === undefined) {
		throw new Error(`Unsupported macOS special key: ${key}`);
	}
	return code;
}

export function createUnsupportedOps(): ComputerOperations {
	const fail = async (): Promise<never> => {
		throw new Error("Computer use not supported on Windows");
	};
	return {
		screenshot: fail,
		cursorPosition: fail,
		mouseMove: fail,
		click: fail,
		doubleClick: fail,
		tripleClick: fail,
		drag: fail,
		mouseDown: fail,
		mouseUp: fail,
		scroll: fail,
		keyPress: fail,
		type: fail,
		holdKey: fail,
		wait: fail,
	};
}

export function createMacOSComputerOps(): ComputerOperations {
	return {
		async screenshot() {
			const filePath = path.join(tmpdir(), `senpi-computer-${randomUUID()}.png`);
			try {
				await run("screencapture", ["-x", "-t", "png", filePath]);
				const buffer = await readFile(filePath);
				return { base64: buffer.toString("base64") };
			} finally {
				await rm(filePath, { force: true });
			}
		},
		async cursorPosition() {
			const output = await run("osascript", [
				"-e",
				'tell app "System Events" to return position of pointer as text',
			]);
			const parts = output.trim().split(",");
			const xRaw = Number.parseInt((parts[0] ?? "0").trim(), 10);
			const yRaw = Number.parseInt((parts[1] ?? "0").trim(), 10);
			return { x: Number.isFinite(xRaw) ? xRaw : 0, y: Number.isFinite(yRaw) ? yRaw : 0 };
		},
		async mouseMove(x, y) {
			await run("cliclick", [`m:${x},${y}`]);
		},
		async click(button, x, y) {
			if (x !== undefined && y !== undefined) {
				await run("cliclick", [`m:${x},${y}`]);
			}
			const command = button === "left" ? "c:." : button === "right" ? "rc:." : "mc:.";
			await run("cliclick", [command]);
		},
		async doubleClick(x, y) {
			if (x !== undefined && y !== undefined) {
				await run("cliclick", [`m:${x},${y}`]);
			}
			await run("cliclick", ["dc:."]);
		},
		async tripleClick(x, y) {
			if (x !== undefined && y !== undefined) {
				await run("cliclick", [`m:${x},${y}`]);
			}
			await run("cliclick", ["tc:."]);
		},
		async drag(startX, startY, endX, endY) {
			await run("cliclick", [`dd:${startX},${startY}`, `du:${endX},${endY}`]);
		},
		async mouseDown(_button, x, y) {
			if (x !== undefined && y !== undefined) {
				await run("cliclick", [`m:${x},${y}`]);
			}
			await run("cliclick", ["dd:."]);
		},
		async mouseUp(_button, x, y) {
			if (x !== undefined && y !== undefined) {
				await run("cliclick", [`m:${x},${y}`]);
			}
			await run("cliclick", ["du:."]);
		},
		async scroll(direction, amount, x, y) {
			if (x !== undefined && y !== undefined) {
				await run("cliclick", [`m:${x},${y}`]);
			}
			const clicks = Math.max(1, Math.round(amount));
			const wheel = direction === "up" ? "wd" : direction === "down" ? "wu" : direction === "left" ? "wl" : "wr";
			await run("cliclick", [`${wheel}:${clicks}`]);
		},
		async keyPress(combo) {
			await run("osascript", ["-e", parseKeyComboToAppleScript(combo)]);
		},
		async type(text) {
			await run("osascript", ["-e", `tell application "System Events" to keystroke ${JSON.stringify(text)}`]);
		},
		async holdKey(combo, durationSec) {
			await run("osascript", ["-e", parseKeyComboToAppleScript(combo)]);
			await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
		},
		async wait(durationSec) {
			await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
		},
	};
}

export function createLinuxComputerOps(): ComputerOperations {
	return {
		async screenshot() {
			const filePath = path.join(tmpdir(), `senpi-computer-${randomUUID()}.png`);
			try {
				await run("scrot", [filePath]);
				const buffer = await readFile(filePath);
				return { base64: buffer.toString("base64") };
			} finally {
				await rm(filePath, { force: true });
			}
		},
		async cursorPosition() {
			const output = await run("xdotool", ["getmouselocation", "--shell"]);
			const xMatch = output.match(/^X=(\d+)$/m);
			const yMatch = output.match(/^Y=(\d+)$/m);
			return {
				x: xMatch ? Number.parseInt(xMatch[1] ?? "0", 10) : 0,
				y: yMatch ? Number.parseInt(yMatch[1] ?? "0", 10) : 0,
			};
		},
		async mouseMove(x, y) {
			await run("xdotool", ["mousemove", `${x}`, `${y}`]);
		},
		async click(button, x, y) {
			if (x !== undefined && y !== undefined) {
				await run("xdotool", ["mousemove", `${x}`, `${y}`]);
			}
			const buttonNumber = button === "left" ? "1" : button === "middle" ? "2" : "3";
			await run("xdotool", ["click", buttonNumber]);
		},
		async doubleClick(x, y) {
			if (x !== undefined && y !== undefined) {
				await run("xdotool", ["mousemove", `${x}`, `${y}`]);
			}
			await run("xdotool", ["click", "--repeat", "2", "1"]);
		},
		async tripleClick(x, y) {
			if (x !== undefined && y !== undefined) {
				await run("xdotool", ["mousemove", `${x}`, `${y}`]);
			}
			await run("xdotool", ["click", "--repeat", "3", "1"]);
		},
		async drag(startX, startY, endX, endY) {
			await run("xdotool", [
				"mousemove",
				`${startX}`,
				`${startY}`,
				"mousedown",
				"1",
				"mousemove",
				`${endX}`,
				`${endY}`,
				"mouseup",
				"1",
			]);
		},
		async mouseDown(_button, x, y) {
			if (x !== undefined && y !== undefined) {
				await run("xdotool", ["mousemove", `${x}`, `${y}`]);
			}
			await run("xdotool", ["mousedown", "1"]);
		},
		async mouseUp(_button, x, y) {
			if (x !== undefined && y !== undefined) {
				await run("xdotool", ["mousemove", `${x}`, `${y}`]);
			}
			await run("xdotool", ["mouseup", "1"]);
		},
		async scroll(direction, amount, x, y) {
			if (x !== undefined && y !== undefined) {
				await run("xdotool", ["mousemove", `${x}`, `${y}`]);
			}
			const button = direction === "up" ? "4" : direction === "down" ? "5" : direction === "left" ? "6" : "7";
			const repeat = `${Math.max(1, Math.round(amount))}`;
			await run("xdotool", ["click", "--repeat", repeat, button]);
		},
		async keyPress(combo) {
			await run("xdotool", ["key", combo]);
		},
		async type(text) {
			await run("xdotool", ["type", "--delay", "12", "--", text]);
		},
		async holdKey(combo, durationSec) {
			await run("xdotool", ["keydown", combo]);
			await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
			await run("xdotool", ["keyup", combo]);
		},
		async wait(durationSec) {
			await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
		},
	};
}

export function createComputerOps(platform: NodeJS.Platform = process.platform): ComputerOperations {
	if (platform === "darwin") {
		return createMacOSComputerOps();
	}
	if (platform === "linux") {
		return createLinuxComputerOps();
	}
	return createUnsupportedOps();
}

async function validateCliDependencies(platform: NodeJS.Platform): Promise<string[]> {
	const missing: string[] = [];
	if (platform === "darwin") {
		if (!(await commandExists("cliclick"))) {
			missing.push("cliclick");
		}
	} else if (platform === "linux") {
		if (!(await commandExists("xdotool"))) {
			missing.push("xdotool");
		}
		if (!(await commandExists("scrot"))) {
			missing.push("scrot");
		}
	}
	return missing;
}

export const ANTHROPIC_COMPUTER_USE_SECTION = `
## Computer Use

The native computer tool is available in this session. The model can
control the screen via screenshot, key, type, mouse actions, scroll,
and wait commands.
`;

function buildComputerUseSection(width: number, height: number): string {
	return `${ANTHROPIC_COMPUTER_USE_SECTION.trimEnd()} Display dimensions: ${width}x${height}. Use computer when the user asks to interact with GUI applications.\n`;
}

export default function anthropicComputerUseExtension(pi: ExtensionAPI): void {
	let extensionDisabledForSession = false;

	pi.on("session_start", async (_event) => {
		if (!enabledByEnv(process.env[ANTHROPIC_COMPUTER_USE_ENV])) {
			extensionDisabledForSession = true;
			return undefined;
		}
		if (!getComputerDisplayConfig()) {
			extensionDisabledForSession = true;
			console.error(
				`[anthropic-computer-use] ${ANTHROPIC_COMPUTER_USE_WIDTH_ENV} and ${ANTHROPIC_COMPUTER_USE_HEIGHT_ENV} must be positive integers; extension disabled for this session.`,
			);
			return undefined;
		}
		extensionDisabledForSession = false;
		const missingTools = await validateCliDependencies(process.platform);
		if (missingTools.length > 0) {
			console.warn(
				`[anthropic-computer-use] Missing OS automation dependencies: ${missingTools.join(", ")}. Install them for full functionality.`,
			);
		}
		return undefined;
	});

	if (enabledByEnv(process.env[ANTHROPIC_COMPUTER_USE_ENV]) && getComputerDisplayConfig()) {
		const ops = createComputerOps();
		pi.registerTool({
			name: ANTHROPIC_NATIVE_COMPUTER_TOOL_NAME,
			label: "Computer Use",
			description:
				"Actions: screenshot, key, type, mouse_move, left/right/middle click, double/triple click, drag, cursor_position, mouse down/up, scroll, hold_key, wait.",
			parameters: computerSchema,
			async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
				const result = await executeComputerAction(params, ops);
				if (result.isError) {
					const firstContent = result.content[0];
					throw new Error(firstContent?.type === "text" ? firstContent.text : "Computer action failed");
				}
				return { content: result.content, details: undefined };
			},
		});
	}

	pi.on("before_provider_request", (event, ctx) => {
		if (extensionDisabledForSession) {
			return event.payload;
		}
		return addAnthropicComputerUseToPayload(ctx.model?.api, event.payload);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.model?.api !== "anthropic-messages") {
			return undefined;
		}
		if (extensionDisabledForSession) {
			return undefined;
		}
		const config = getComputerDisplayConfig();
		if (!enabledByEnv(process.env[ANTHROPIC_COMPUTER_USE_ENV]) || !config) {
			return undefined;
		}
		return {
			systemPrompt: `${event.systemPrompt}\n${buildComputerUseSection(config.width, config.height)}`,
		};
	});
}
