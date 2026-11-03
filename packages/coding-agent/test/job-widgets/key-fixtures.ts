// Synthetic private keys for redaction tests. Key text is assembled at runtime from parts and
// synthetic base64, so no literal key marker or key-shaped body is checked in (secret scanners).

const DASHES = "-".repeat(5);
const PRIVATE_KEY = ["PRIV", "ATE", " KEY"].join("");

export function armor(edge: "BEGIN" | "END", label: string): string {
	return `${DASHES}${edge} ${label}${DASHES}`;
}

/** Deterministic synthetic base64 (mulberry32), so a failure reproduces. */
function base64Source(seed: number): (length: number) => string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let state = seed >>> 0;
	const next = (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return (length) => Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
}

export interface KeyForm {
	readonly name: string;
	readonly label: string;
	readonly width: number;
	/** Armor lines between the BEGIN line and the body. */
	readonly headers: readonly string[];
	/** A PGP armor checksum line after the body. */
	readonly checksum: boolean;
}

export const KEY_FORMS: readonly KeyForm[] = [
	{ name: "RSA", label: `RSA ${PRIVATE_KEY}`, width: 64, headers: [], checksum: false },
	{ name: "EC", label: `EC ${PRIVATE_KEY}`, width: 64, headers: [], checksum: false },
	{ name: "OPENSSH", label: `OPENSSH ${PRIVATE_KEY}`, width: 70, headers: [], checksum: false },
	{ name: "PKCS#8", label: PRIVATE_KEY, width: 64, headers: [], checksum: false },
	{ name: "ENCRYPTED PKCS#8", label: `ENCRYPTED ${PRIVATE_KEY}`, width: 64, headers: [], checksum: false },
	{
		name: "legacy encrypted RSA",
		label: `RSA ${PRIVATE_KEY}`,
		width: 64,
		headers: ["Proc-Type: 4,ENCRYPTED", `DEK-Info: AES-128-CBC,${"0F".repeat(16)}`, ""],
		checksum: false,
	},
	{ name: "PGP", label: `PGP ${PRIVATE_KEY} BLOCK`, width: 64, headers: [""], checksum: true },
];

export interface Key {
	readonly lines: readonly string[];
	/** The secret: every body line. */
	readonly body: readonly string[];
	/** Index in `lines` of the first body line. */
	readonly bodyStart: number;
}

export function makeKey(form: KeyForm, seed: number): Key {
	const random = base64Source(seed);
	const body = [...Array.from({ length: 12 }, () => random(form.width)), `${random(30)}==`];
	const lines = [
		armor("BEGIN", form.label),
		...form.headers,
		...body,
		...(form.checksum ? [`=${random(4)}`] : []),
		armor("END", form.label),
	];
	return { lines, body, bodyStart: 1 + form.headers.length };
}

/** Every 16-character slice of a body line found in `text`. */
export function leakedSlices(text: string, body: readonly string[]): string[] {
	const found: string[] = [];
	for (const line of body) {
		for (let at = 0; at + 16 <= line.length; at++) {
			const slice = line.slice(at, at + 16);
			if (text.includes(slice)) {
				found.push(slice);
				break;
			}
		}
	}
	return found;
}
