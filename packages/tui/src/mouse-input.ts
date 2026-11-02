import type { TuiMouseButton, TuiMouseEvent } from "./tui.ts";

export interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}
export interface WheelEvent {
	direction: -1 | 1;
	x: number;
	y: number;
	button: number;
}
export const MOUSE_TRACKING = {
	buttonMotion: "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h",
	allMotion: "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h",
	inline: "\x1b[?1006h\x1b[?1000h",
	disable: "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l",
};

/** Decode SGR's one-based wire coordinates into zero-based cells. */
export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (!match) return undefined;
	const button = Number(match[1]);
	const x = Number(match[2]) - 1;
	const y = Number(match[3]) - 1;
	if (button > 255 || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) return undefined;
	return { button, x, y, release: match[4] === "m" };
}

export function parseWheelEvent(data: string): WheelEvent | undefined {
	const raw =
		parseSgrMouseEvent(data) ??
		(data.length === 6 && data.startsWith("\x1b[M")
			? { button: data.charCodeAt(3) - 32, x: data.charCodeAt(4) - 33, y: data.charCodeAt(5) - 33 }
			: undefined);
	if (!raw || raw.button < 0 || raw.button > 255 || (raw.button & 64) === 0) return undefined;
	const direction = raw.button & 3;
	if (direction !== 0 && direction !== 1) return undefined;
	return { direction: direction === 0 ? -1 : 1, x: raw.x, y: raw.y, button: raw.button };
}

export function isMouseSequence(data: string): boolean {
	return data.startsWith("\x1b[<") || data.startsWith("\x1b[M");
}

export function decodeMouseButton(button: number): TuiMouseButton {
	switch (button & 3) {
		case 0:
			return "left";
		case 1:
			return "middle";
		case 2:
			return "right";
		default:
			return "none";
	}
}

export function toTuiMouseEvent(
	type: TuiMouseEvent["type"],
	raw: SgrMouseEvent,
	size: { columns: number; rows: number },
	extra: Partial<Pick<TuiMouseEvent, "wheelDelta" | "clickCount">> = {},
): TuiMouseEvent {
	return {
		type,
		button: type === "wheel" ? "none" : decodeMouseButton(raw.button),
		x: raw.x,
		y: raw.y,
		screenX: raw.x,
		screenY: raw.y,
		width: Math.max(1, size.columns),
		height: Math.max(1, size.rows),
		shift: (raw.button & 4) !== 0,
		alt: (raw.button & 8) !== 0,
		ctrl: (raw.button & 16) !== 0,
		...extra,
	};
}

interface ClickPoint {
	x: number;
	y: number;
	target: object;
	epoch: number;
	time: number;
}

/** Gesture state uses explicit timestamps so callers/tests need no timers. */
export class MouseClickSynthesizer {
	private pressed?: ClickPoint;
	private last?: ClickPoint & { count: number };

	press(raw: SgrMouseEvent, target: object, epoch: number, now = Date.now()): void {
		this.pressed = { x: raw.x, y: raw.y, target, epoch, time: now };
	}

	release(raw: SgrMouseEvent, target: object, epoch: number, now = Date.now()): number | undefined {
		const press = this.pressed;
		this.pressed = undefined;
		if (
			!press ||
			press.x !== raw.x ||
			press.y !== raw.y ||
			press.target !== target ||
			press.epoch !== epoch ||
			now - press.time > 500 ||
			now < press.time
		) {
			this.last = undefined;
			return undefined;
		}
		const last = this.last;
		const count =
			last &&
			last.x === raw.x &&
			last.y === raw.y &&
			last.target === target &&
			last.epoch === epoch &&
			now - last.time <= 500
				? (last.count % 3) + 1
				: 1;
		this.last = { ...press, time: now, count };
		return count;
	}

	cancel(): void {
		this.pressed = undefined;
		this.last = undefined;
	}
}
