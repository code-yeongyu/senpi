import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type DetectedTerminalCapabilities,
	detectTerminalCapabilities,
	type TerminalCapabilities,
} from "./terminal-capabilities.ts";
import { sanitizeTerminalLabel, shortenImagePath } from "./terminal-text.ts";

export type { ImageProtocol, TerminalCapabilities } from "./terminal-capabilities.ts";
export { outerKittyGraphicsMode } from "./terminal-capabilities.ts";

export interface TmuxPassthroughState {
	allowPassthrough: "off" | "on" | "all";
	clientTermname: string;
	cellWidthPx?: number;
	cellHeightPx?: number;
}

export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageRenderOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	preserveAspectRatio?: boolean;
	/** Kitty image ID. If provided, reuses/replaces existing image with this ID. */
	imageId?: number;
	/** Whether Kitty should apply its default cursor movement after placement. */
	moveCursor?: boolean;
}

let cachedCapabilities: TerminalCapabilities | null = null;

// Default cell dimensions - updated by TUI when terminal responds to query
let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

export function getCellDimensions(): CellDimensions {
	return cellDimensions;
}

export function setCellDimensions(dims: CellDimensions): void {
	cellDimensions = dims;
}

export function detectCapabilities(
	tmuxForwardsHyperlink?: () => boolean,
	tmuxPassthroughState?: () => TmuxPassthroughState,
): DetectedTerminalCapabilities {
	if (!tmuxForwardsHyperlink || !tmuxPassthroughState) return detectTerminalCapabilities();

	const legacy = tmuxPassthroughState();
	const hyperlinks = tmuxForwardsHyperlink();
	const detected = detectTerminalCapabilities(
		{ ...process.env, TMUX: process.env.TMUX ?? "compat,0,0" },
		process.platform,
		() =>
			[
				"3.4",
				legacy.allowPassthrough,
				"on",
				"1",
				"1",
				"1",
				legacy.clientTermname,
				legacy.cellWidthPx ?? "",
				legacy.cellHeightPx ?? "",
				hyperlinks ? "hyperlinks" : "",
			].join("|"),
	);
	if (detected.cellDimensions) setCellDimensions(detected.cellDimensions);
	return { ...detected, hyperlinks };
}

export function getCapabilities(): TerminalCapabilities {
	if (!cachedCapabilities) {
		const detected = detectCapabilities();
		if (detected.cellDimensions) setCellDimensions(detected.cellDimensions);
		cachedCapabilities = detected;
	}
	return cachedCapabilities;
}

export function resetCapabilitiesCache(): void {
	cachedCapabilities = null;
}

/** Override the cached capabilities. Useful in tests to exercise both code paths. */
export function setCapabilities(caps: TerminalCapabilities): void {
	cachedCapabilities = caps;
}

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";

/**
 * Wrap an escape sequence in a tmux DCS passthrough envelope so tmux forwards
 * it verbatim to the outer terminal (requires `allow-passthrough`). Every ESC
 * inside the payload must be doubled per the tmux protocol.
 */
export function wrapTmuxPassthrough(sequence: string): string {
	return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

export function isImageLine(line: string): boolean {
	// Fast path: sequence at line start (single-row images)
	if (line.startsWith(KITTY_PREFIX) || line.startsWith(ITERM2_PREFIX)) {
		return true;
	}
	// Slow path: sequence elsewhere (multi-row images have cursor-up prefix)
	return line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX);
}

/**
 * Generate a random image ID for Kitty graphics protocol.
 * Uses random IDs to avoid collisions between different module instances
 * (e.g., main app vs extensions).
 */
export function allocateImageId(): number {
	// Use random ID in range [1, 0xffffffff] to avoid collisions
	return Math.floor(Math.random() * 0xfffffffe) + 1;
}

export function encodeKitty(
	base64Data: string,
	options: {
		columns?: number;
		rows?: number;
		imageId?: number;
		/** Whether Kitty should apply its default cursor movement after placement. Default: true. */
		moveCursor?: boolean;
		/**
		 * Create a virtual placement (`U=1`) for Unicode placeholders instead of
		 * placing the image at the cursor. The image is only shown where
		 * placeholder cells (see {@link buildKittyPlaceholderRow}) are printed.
		 */
		virtual?: boolean;
	} = {},
): string {
	const CHUNK_SIZE = 4096;

	const params: string[] = ["a=T", "f=100", "q=2"];

	if (options.virtual) params.push("U=1");
	else if (options.moveCursor === false) params.push("C=1");
	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) params.push(`i=${options.imageId}`);

	const chunks: string[] = [];

	if (base64Data.length <= CHUNK_SIZE) {
		chunks.push(`\x1b_G${params.join(",")};${base64Data}\x1b\\`);
	} else {
		let offset = 0;
		let isFirst = true;

		while (offset < base64Data.length) {
			const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
			const isLast = offset + CHUNK_SIZE >= base64Data.length;

			if (isFirst) {
				chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
				isFirst = false;
			} else if (isLast) {
				chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
			} else {
				chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
			}

			offset += CHUNK_SIZE;
		}
	}

	// Under tmux passthrough every APC chunk must be wrapped individually so
	// tmux forwards each one as its own DCS envelope.
	if (getCapabilities().tmuxPassthrough) {
		return chunks.map(wrapTmuxPassthrough).join("");
	}

	return chunks.join("");
}

/**
 * Placeholder codepoint for Kitty Unicode placements (U+10EEEE). Each cell of
 * a virtual placement is this character with combining diacritics encoding the
 * row/column and the foreground color encoding the image ID.
 */
const KITTY_PLACEHOLDER = String.fromCodePoint(0x10eeee);

/**
 * Row/column index diacritics from the Kitty graphics protocol
 * (rowcolumn-diacritics.txt): diacritic at index N encodes row/column N.
 */
const KITTY_PLACEHOLDER_DIACRITICS: readonly number[] = [
	0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351,
	0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d,
	0x036e, 0x036f, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599,
	0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1, 0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611,
	0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6,
	0x06d7, 0x06d8, 0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2, 0x06e4, 0x06e7, 0x06e8, 0x06eb,
	0x06ec, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736, 0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743, 0x0745, 0x0747,
	0x0749, 0x074a, 0x07eb, 0x07ec, 0x07ed, 0x07ee, 0x07ef, 0x07f0, 0x07f1, 0x07f3, 0x0816, 0x0817, 0x0818, 0x0819,
	0x081b, 0x081c, 0x081d, 0x081e, 0x081f, 0x0820, 0x0821, 0x0822, 0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082a,
	0x082b, 0x082c, 0x082d, 0x0951, 0x0953, 0x0954, 0x0f82, 0x0f83, 0x0f86, 0x0f87, 0x135d, 0x135e, 0x135f, 0x17dd,
	0x193a, 0x1a17, 0x1a75, 0x1a76, 0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b, 0x1b6d, 0x1b6e, 0x1b6f,
	0x1b70, 0x1b71, 0x1b72, 0x1b73, 0x1cd0, 0x1cd1, 0x1cd2, 0x1cda, 0x1cdb, 0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4,
	0x1dc5, 0x1dc6, 0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc, 0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5, 0x1dd6, 0x1dd7,
	0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc, 0x1ddd, 0x1dde, 0x1ddf, 0x1de0, 0x1de1, 0x1de2, 0x1de3, 0x1de4, 0x1de5,
	0x1de6, 0x1dfe, 0x20d0, 0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7, 0x20db, 0x20dc, 0x20e1, 0x20e7, 0x20e9, 0x20f0,
	0x2cef, 0x2cf0, 0x2cf1, 0x2de0, 0x2de1, 0x2de2, 0x2de3, 0x2de4, 0x2de5, 0x2de6, 0x2de7, 0x2de8, 0x2de9, 0x2dea,
	0x2deb, 0x2dec, 0x2ded, 0x2dee, 0x2def, 0x2df0, 0x2df1, 0x2df2, 0x2df3, 0x2df4, 0x2df5, 0x2df6, 0x2df7, 0x2df8,
	0x2df9, 0x2dfa, 0x2dfb, 0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c, 0xa67d, 0xa6f0, 0xa6f1, 0xa8e0, 0xa8e1,
	0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8, 0xa8e9, 0xa8ea, 0xa8eb, 0xa8ec, 0xa8ed, 0xa8ee, 0xa8ef,
	0xa8f0, 0xa8f1, 0xaab0, 0xaab2, 0xaab3, 0xaab7, 0xaab8, 0xaabe, 0xaabf, 0xaac1, 0xfe20, 0xfe21, 0xfe22, 0xfe23,
	0xfe24, 0xfe25, 0xfe26, 0x10a0f, 0x10a38, 0x1d185, 0x1d186, 0x1d187, 0x1d188, 0x1d189, 0x1d1aa, 0x1d1ab, 0x1d1ac,
	0x1d1ad, 0x1d242, 0x1d243, 0x1d244,
];

/** Maximum rows/columns addressable by Kitty Unicode placeholder diacritics. */
export const KITTY_PLACEHOLDER_MAX = KITTY_PLACEHOLDER_DIACRITICS.length;

/**
 * Build one row of Kitty Unicode placeholder cells for a virtual placement.
 * The foreground color carries the low 24 bits of the image ID; the third
 * diacritic carries the high byte when present. Placeholder cells are plain
 * text (1 column each), so tmux and the TUI treat them like any other line.
 */
export function buildKittyPlaceholderRow(imageId: number, row: number, columns: number): string {
	const rowDiacritic = String.fromCodePoint(KITTY_PLACEHOLDER_DIACRITICS[Math.min(row, KITTY_PLACEHOLDER_MAX - 1)]);
	const idHighByte = (imageId >>> 24) & 0xff;
	const idDiacritic = idHighByte > 0 ? String.fromCodePoint(KITTY_PLACEHOLDER_DIACRITICS[idHighByte]) : "";
	const r = (imageId >>> 16) & 0xff;
	const g = (imageId >>> 8) & 0xff;
	const b = imageId & 0xff;

	let cells = "";
	for (let column = 0; column < columns; column++) {
		const columnDiacritic = String.fromCodePoint(
			KITTY_PLACEHOLDER_DIACRITICS[Math.min(column, KITTY_PLACEHOLDER_MAX - 1)],
		);
		cells += KITTY_PLACEHOLDER + rowDiacritic + columnDiacritic + idDiacritic;
	}
	return `\x1b[38;2;${r};${g};${b}m${cells}\x1b[39m`;
}

/**
 * Delete a Kitty graphics image by ID.
 * Uses uppercase 'I' to also free the image data.
 */
export function deleteKittyImage(imageId: number): string {
	const sequence = `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
	return getCapabilities().tmuxPassthrough ? wrapTmuxPassthrough(sequence) : sequence;
}

/**
 * Delete all visible Kitty graphics images.
 * Uses uppercase 'A' to also free the image data.
 */
export function deleteAllKittyImages(): string {
	const sequence = "\x1b_Ga=d,d=A,q=2\x1b\\";
	return getCapabilities().tmuxPassthrough ? wrapTmuxPassthrough(sequence) : sequence;
}

export function encodeITerm2(
	base64Data: string,
	options: {
		width?: number | string;
		height?: number | string;
		name?: string;
		preserveAspectRatio?: boolean;
		inline?: boolean;
	} = {},
): string {
	const params: string[] = [`inline=${options.inline !== false ? 1 : 0}`];

	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) {
		const nameBase64 = Buffer.from(options.name).toString("base64");
		params.push(`name=${nameBase64}`);
	}
	if (options.preserveAspectRatio === false) {
		params.push("preserveAspectRatio=0");
	}

	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

export interface ImageCellSize {
	columns: number;
	rows: number;
}

export interface KittyImageMetadata extends ImageCellSize {
	imageId: number;
	widthPx: number;
	heightPx: number;
}

const kittyImageMetadata = new Map<number, KittyImageMetadata>();

export function registerKittyImageMetadata(metadata: KittyImageMetadata): void {
	kittyImageMetadata.delete(metadata.imageId);
	kittyImageMetadata.set(metadata.imageId, metadata);
	if (kittyImageMetadata.size > 1000) {
		const oldestImageId = kittyImageMetadata.keys().next().value;
		if (oldestImageId !== undefined) kittyImageMetadata.delete(oldestImageId);
	}
}

export function getKittyImageMetadata(line: string): KittyImageMetadata | undefined {
	const controls = /\x1b_G([^;]*);/.exec(line)?.[1];
	if (!controls) return undefined;
	const imageId = /(?:^|,)i=(\d+)(?:,|$)/.exec(controls)?.[1];
	return imageId === undefined ? undefined : kittyImageMetadata.get(Number.parseInt(imageId, 10));
}

export function cropKittyImageLine(line: string, hiddenRows: number, visibleRows: number): string {
	const metadata = getKittyImageMetadata(line);
	const match = /\x1b_G([^;]*);/.exec(line);
	if (!metadata || !match || hiddenRows < 0 || hiddenRows >= metadata.rows || visibleRows <= 0) return line;
	const croppedRows = Math.min(visibleRows, metadata.rows - hiddenRows);
	if (hiddenRows === 0 && croppedRows === metadata.rows) return line;
	const sourceY = Math.floor((metadata.heightPx * hiddenRows) / metadata.rows);
	const sourceEnd = Math.ceil((metadata.heightPx * (hiddenRows + croppedRows)) / metadata.rows);
	const sourceHeight = Math.max(1, Math.min(metadata.heightPx, sourceEnd) - sourceY);
	const controls = match[1].split(",").filter((control) => !/^[yhr]=/.test(control));
	controls.push(`y=${sourceY}`, `h=${sourceHeight}`, `r=${croppedRows}`);
	return `${line.slice(0, match.index)}\x1b_G${controls.join(",")};${line.slice(match.index + match[0].length)}`;
}

export function calculateImageCellSize(
	imageDimensions: ImageDimensions,
	maxWidthCells: number,
	maxHeightCells?: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
): ImageCellSize {
	const maxWidth = Math.max(1, Math.floor(maxWidthCells));
	const maxHeight = maxHeightCells === undefined ? undefined : Math.max(1, Math.floor(maxHeightCells));
	const imageWidth = Math.max(1, imageDimensions.widthPx);
	const imageHeight = Math.max(1, imageDimensions.heightPx);

	const widthScale = (maxWidth * cellDimensions.widthPx) / imageWidth;
	const heightScale = maxHeight === undefined ? widthScale : (maxHeight * cellDimensions.heightPx) / imageHeight;
	const scale = Math.min(widthScale, heightScale);

	const scaledWidthPx = imageWidth * scale;
	const scaledHeightPx = imageHeight * scale;
	const columns = Math.ceil(scaledWidthPx / cellDimensions.widthPx);
	const rows = Math.ceil(scaledHeightPx / cellDimensions.heightPx);

	return {
		columns: Math.max(1, Math.min(maxWidth, columns)),
		rows: Math.max(1, maxHeight === undefined ? rows : Math.min(maxHeight, rows)),
	};
}

export function getPngDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 24) {
			return null;
		}

		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			return null;
		}

		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getJpegDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 2) {
			return null;
		}

		if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
			return null;
		}

		let offset = 2;
		while (offset < buffer.length - 9) {
			if (buffer[offset] !== 0xff) {
				offset++;
				continue;
			}

			const marker = buffer[offset + 1];

			if (marker >= 0xc0 && marker <= 0xc2) {
				const height = buffer.readUInt16BE(offset + 5);
				const width = buffer.readUInt16BE(offset + 7);
				return { widthPx: width, heightPx: height };
			}

			if (offset + 3 >= buffer.length) {
				return null;
			}
			const length = buffer.readUInt16BE(offset + 2);
			if (length < 2) {
				return null;
			}
			offset += 2 + length;
		}

		return null;
	} catch {
		return null;
	}
}

export function getGifDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 10) {
			return null;
		}

		const sig = buffer.subarray(0, 6).toString("ascii");
		if (sig !== "GIF87a" && sig !== "GIF89a") {
			return null;
		}

		const width = buffer.readUInt16LE(6);
		const height = buffer.readUInt16LE(8);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getWebpDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 30) {
			return null;
		}

		const riff = buffer.subarray(0, 4).toString("ascii");
		const webp = buffer.subarray(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") {
			return null;
		}

		const chunk = buffer.subarray(12, 16).toString("ascii");
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null;
			const width = buffer.readUInt16LE(26) & 0x3fff;
			const height = buffer.readUInt16LE(28) & 0x3fff;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8L") {
			if (buffer.length < 25) return null;
			const bits = buffer.readUInt32LE(21);
			const width = (bits & 0x3fff) + 1;
			const height = ((bits >> 14) & 0x3fff) + 1;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8X") {
			if (buffer.length < 30) return null;
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			return { widthPx: width, heightPx: height };
		}

		return null;
	} catch {
		return null;
	}
}

export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null {
	if (mimeType === "image/png") {
		return getPngDimensions(base64Data);
	}
	if (mimeType === "image/jpeg") {
		return getJpegDimensions(base64Data);
	}
	if (mimeType === "image/gif") {
		return getGifDimensions(base64Data);
	}
	if (mimeType === "image/webp") {
		return getWebpDimensions(base64Data);
	}
	return null;
}

export function renderImage(
	base64Data: string,
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions = {},
): { sequence: string; columns: number; rows: number; imageId?: number; lines?: string[] } | null {
	const caps = getCapabilities();

	if (!caps.images) {
		return null;
	}

	const maxWidth = options.maxWidthCells ?? 80;
	const size = calculateImageCellSize(imageDimensions, maxWidth, options.maxHeightCells, getCellDimensions());

	if (caps.images === "kitty" && caps.kittyUnicodePlaceholders) {
		// Virtual placement: transmit once, then show the image with plain-text
		// placeholder cells. Under tmux the placeholder cells move/clip with the
		// pane, so split layouts render correctly.
		const imageId = options.imageId ?? allocateImageId();
		const columns = Math.min(size.columns, KITTY_PLACEHOLDER_MAX);
		const rows = Math.min(size.rows, KITTY_PLACEHOLDER_MAX);
		const sequence = encodeKitty(base64Data, { columns, rows, imageId, virtual: true });
		const lines: string[] = [];
		for (let row = 0; row < rows; row++) {
			const placeholderRow = buildKittyPlaceholderRow(imageId, row, columns);
			lines.push(row === 0 ? sequence + placeholderRow : placeholderRow);
		}
		return { sequence, columns, rows, imageId, lines };
	}

	if (caps.images === "kitty") {
		if (options.imageId !== undefined) {
			registerKittyImageMetadata({
				imageId: options.imageId,
				columns: size.columns,
				rows: size.rows,
				widthPx: imageDimensions.widthPx,
				heightPx: imageDimensions.heightPx,
			});
		}
		const sequence = encodeKitty(base64Data, {
			columns: size.columns,
			rows: size.rows,
			imageId: options.imageId,
			moveCursor: options.moveCursor,
		});
		return { sequence, columns: size.columns, rows: size.rows, imageId: options.imageId };
	}

	if (caps.images === "iterm2") {
		const sequence = encodeITerm2(base64Data, {
			width: size.columns,
			height: "auto",
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		return { sequence, columns: size.columns, rows: size.rows };
	}

	return null;
}

/**
 * Wrap text in an OSC 8 hyperlink sequence.
 * The text is rendered as a clickable hyperlink in terminals that support OSC 8
 * (Ghostty, Kitty, WezTerm, iTerm2, VSCode, and others).
 * In terminals that do not support OSC 8, the escape sequences are ignored
 * and only the plain text is displayed.
 *
 * @param text - The visible text to display
 * @param url - The URL to link to
 */
export function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const parts: string[] = [];
	if (filename) {
		const sanitized = sanitizeTerminalLabel(filename);
		const display = shortenImagePath(sanitized);
		parts.push(
			getCapabilities().hyperlinks && isAbsolute(sanitized)
				? hyperlink(display, pathToFileURL(sanitized).href)
				: display,
		);
	}
	parts.push(`[${sanitizeTerminalLabel(mimeType)}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}
