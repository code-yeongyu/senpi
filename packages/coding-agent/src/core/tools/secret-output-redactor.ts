const REDACTED = "<redacted>";
const TOKEN_CHAR = /[A-Za-z0-9_./+~=-]/;
const SECRET_KEY = /(?:^|_)(?:KEY|TOKEN|SECRET|AUTH|AUTHORIZATION)$|PASSWORD/i;
const SECRET_PREFIXES = [
	"ghp_",
	"gho_",
	"ghr_",
	"ghs_",
	"ghu_",
	"github_pat_",
	"xoxa-",
	"xoxb-",
	"xoxp-",
	"xoxo-",
	"xoxr-",
	"xoxs-",
	"sk-ant-",
	"sk-proj-",
	"sk-",
];
const PREFIX = new RegExp(`(?:^|[^A-Za-z0-9])(?:${SECRET_PREFIXES.join("|")})[A-Za-z0-9_./+~=-]+`);
const STARTED_PREFIX = new RegExp(`(?:^|[^A-Za-z0-9])(?:${SECRET_PREFIXES.join("|")}|AKIA|AIza|eyJ)`);
const CLOUD_KEY = /(?:^|[^A-Za-z0-9])(?:AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35})/;
const BEARER_VALUE = /^(?=.{8,}$)(?=.*[0-9_./+~=-])[A-Za-z0-9_./+~=-]+$/;
const JWT = /^([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.?$/;
const PRIVATE_HEADER = /^-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----$/;
const PRIVATE_END = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----$/;
// Never release an undecided prefix to bound memory: an oversized token is redacted whole.
const MAX_TOKEN_CHARS = 8192;

function isJwt(token: string): boolean {
	const header = JWT.exec(token)?.[1];
	if (!header) return false;
	try {
		const value: unknown = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
		return typeof value === "object" && value !== null && "alg" in value && typeof value.alg === "string";
	} catch {
		return false;
	}
}

/**
 * One redactor per output stream. push() holds incomplete tokens; finish() seals EOF.
 * flushIdle() publishes ordinary fragments but retains their logical token for re-evaluation.
 */
export class SecretOutputRedactor {
	private token = "";
	private rawToken = "";
	private controls = "";
	private escape: "start" | "charset" | "csi" | "osc" | "osc-end" | undefined;
	private escapeText = "";
	private oversized = false;
	private bearer = false;
	private value: "start" | "bare" | "quoted" | undefined;
	private quote = "";
	private escaped = false;
	private pem: "header" | "body" | undefined;
	private pemTail = "";
	private finished = false;

	push(text: string): string {
		if (this.finished) return "";
		let output = "";
		for (const character of text) {
			if (this.escape !== undefined) {
				if (this.escape === "osc" || this.escape === "osc-end") {
					if (character === "\x07" || (this.escape === "osc-end" && character === "\\")) this.escape = undefined;
					else this.escape = character === "\x1b" ? "osc-end" : "osc";
					continue;
				}
				this.escapeText += character;
				if (this.escape === "start" && character === "]") {
					this.escape = "osc";
					this.escapeText = "";
					continue;
				}
				if (this.escape === "start" && character === "[") {
					this.escape = "csi";
					continue;
				}
				if (this.escape === "start" && /[()*+]/.test(character)) {
					this.escape = "charset";
					continue;
				}
				if (
					this.escape === "start" ||
					this.escape === "charset" ||
					/[@-~]/.test(character) ||
					this.escapeText.length > 64
				) {
					if (this.pem === undefined && this.value === undefined) {
						if (this.oversized) output += this.escapeText;
						else {
							this.rawToken += this.escapeText;
							this.controls += this.escapeText;
						}
						if (this.rawToken.length > MAX_TOKEN_CHARS) {
							this.token = "";
							this.rawToken = "";
							this.controls = "";
							this.oversized = true;
							output += REDACTED;
						}
					}
					this.escape = undefined;
					this.escapeText = "";
				}
				continue;
			}
			if (character === "\x1b") {
				this.escape = "start";
				this.escapeText = character;
				continue;
			}
			if (this.pem !== undefined) {
				this.pemTail += character;
				if (this.pem === "header") {
					if (this.pemTail.endsWith("-----")) {
						if (PRIVATE_HEADER.test(this.pemTail)) {
							output += REDACTED;
							this.pem = "body";
						} else {
							output += this.pemTail;
							this.pem = undefined;
						}
						this.pemTail = "";
					} else if (this.pemTail.length > 128 || character === "\n") {
						output += this.pemTail;
						this.pemTail = "";
						this.pem = undefined;
					}
				} else {
					this.pemTail = this.pemTail.slice(-128);
					if (PRIVATE_END.test(this.pemTail)) {
						this.pemTail = "";
						this.pem = undefined;
					}
				}
				continue;
			}
			if (this.value !== undefined) {
				if (this.value === "start") {
					if (character === " " || character === "\t") {
						output += character;
						continue;
					}
					if (character === '"' || character === "'") {
						this.quote = character;
						this.value = "quoted";
						output += character + REDACTED;
						continue;
					}
					this.value = "bare";
					output += REDACTED;
				}
				if (this.value === "quoted") {
					if (character === "\n" || character === "\r") {
						this.value = undefined;
						this.escaped = false;
						output += character;
					} else if (this.escaped) this.escaped = false;
					else if (character === "\\") this.escaped = true;
					else if (character === this.quote) {
						output += character;
						this.value = undefined;
					}
					continue;
				}
				if (!/[\s'"]/.test(character)) continue;
				this.value = undefined;
			}
			if (character === "=" && !this.bearer && !this.oversized && /^[A-Za-z_][A-Za-z0-9_]*$/.test(this.token)) {
				const secret = SECRET_KEY.test(this.token);
				output += this.flushToken() + "=";
				if (secret) this.value = "start";
				continue;
			}
			if (TOKEN_CHAR.test(character)) {
				if (this.oversized) continue;
				this.token += character;
				this.rawToken += character;
				if (this.rawToken.length > MAX_TOKEN_CHARS || this.token.length > MAX_TOKEN_CHARS) {
					this.token = "";
					this.rawToken = "";
					this.controls = "";
					this.oversized = true;
					output += REDACTED;
				}
				continue;
			}
			if (this.token === "-----BEGIN" && character === " ") {
				this.pem = "header";
				this.pemTail = this.token + character;
				this.token = "";
				this.rawToken = "";
				this.controls = "";
				continue;
			}
			output += this.flushToken();
			output += character;
			if (!/\s/.test(character)) this.bearer = false;
		}
		return output;
	}

	/**
	 * Publish ordinary prompts without treating the pause as a token boundary.
	 * Once a public credential prefix is present, withhold the token until it ends.
	 */
	flushIdle(): string {
		if (this.finished || this.oversized) return "";
		const token = this.token;
		// A PEM opener has spaces: keep parsing it rather than suppressing only its
		// first word and accidentally releasing the following private-key body.
		if (token.length > 0 && "-----BEGIN".startsWith(token)) return "";
		if (this.startedPrefix() !== undefined || this.isSecret(token)) return "";
		const output = this.rawToken;
		this.rawToken = "";
		this.controls = "";
		// Keep the logical token after publishing ordinary text: a following '=' still
		// needs its key, and a following credential prefix still needs its boundary.
		return output;
	}

	finish(): string {
		if (this.finished) return "";
		this.finished = true;
		const tail = this.pem === "header" ? this.pemTail : "";
		this.pemTail = "";
		return tail + this.flushToken();
	}

	private isSecret(token: string): boolean {
		return (this.bearer && BEARER_VALUE.test(token)) || PREFIX.test(token) || CLOUD_KEY.test(token) || isJwt(token);
	}

	private startedPrefix(): string | undefined {
		if (this.bearer && this.token.length > 0) return "";
		const match = STARTED_PREFIX.exec(this.token);
		return match ? this.token.slice(0, match.index + match[0].length) : undefined;
	}

	private flushToken(): string {
		if (this.oversized) {
			this.oversized = false;
			this.bearer = false;
			return "";
		}
		const token = this.token;
		const rawToken = this.rawToken;
		const controls = this.controls;
		const prefix = this.finished ? this.startedPrefix() : undefined;
		this.token = "";
		this.rawToken = "";
		this.controls = "";
		if (token.length === 0) return rawToken;
		const secret = token !== prefix && this.isSecret(token);
		this.bearer = !secret && /^Bearer$/i.test(token);
		if (secret) return controls + REDACTED;
		if (prefix !== undefined) {
			const published = token.length - (rawToken.length - controls.length);
			return controls + prefix.slice(published) + REDACTED;
		}
		return rawToken;
	}
}
