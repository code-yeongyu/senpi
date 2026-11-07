import {
	createCipheriv,
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	sign,
	type KeyObject,
} from "node:crypto";

/**
 * The presenter's half of a sealed secret answer, written for the tests from RFC 9180 and the design text (4.2, 4.3):
 * the binding, padding, HPKE base-mode seal and the installation key's envelope signature. It shares no code with the
 * engine, so a test that opens what this seals checks the engine against an independent implementation.
 */

const HPKE_SUITE = Buffer.concat([Buffer.from("HPKE"), Buffer.from([0x00, 0x20, 0x00, 0x01, 0x00, 0x02])]);
const KEM_SUITE = Buffer.concat([Buffer.from("KEM"), Buffer.from([0x00, 0x20])]);
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
const labeledExtract = (suite: Buffer, salt: Buffer, label: string, ikm: Buffer) =>
	hmac(
		salt.length > 0 ? salt : Buffer.alloc(32),
		Buffer.concat([Buffer.from("HPKE-v1"), suite, Buffer.from(label), ikm]),
	);
function labeledExpand(suite: Buffer, prk: Buffer, label: string, info: Buffer, length: number): Buffer {
	const labeled = Buffer.concat([Buffer.from([0, length]), Buffer.from("HPKE-v1"), suite, Buffer.from(label), info]);
	let block = Buffer.alloc(0);
	let output = Buffer.alloc(0);
	for (let counter = 1; output.length < length; counter++) {
		block = hmac(prk, Buffer.concat([block, labeled, Buffer.from([counter])]));
		output = Buffer.concat([output, block]);
	}
	return output.subarray(0, length);
}

const x25519Public = (raw: Buffer) =>
	createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });

/** RFC 9180 base mode, one shot. `ephemeral` pins skE for the published vector; otherwise a fresh key. */
export function hpkeSeal(input: {
	readonly recipient: Buffer;
	readonly info: Buffer;
	readonly aad: Buffer;
	readonly plaintext: Buffer;
	readonly ephemeral?: { readonly secret: Buffer; readonly public: Buffer };
}): { enc: Buffer; ct: Buffer } {
	const ephemeral = input.ephemeral
		? createPrivateKey({
				key: {
					kty: "OKP",
					crv: "X25519",
					d: input.ephemeral.secret.toString("base64url"),
					x: input.ephemeral.public.toString("base64url"),
				},
				format: "jwk",
			})
		: generateKeyPairSync("x25519").privateKey;
	const enc = Buffer.from(String(createPublicKey(ephemeral).export({ format: "jwk" }).x), "base64url");
	const dh = diffieHellman({ privateKey: ephemeral, publicKey: x25519Public(input.recipient) });
	const eae = labeledExtract(KEM_SUITE, Buffer.alloc(0), "eae_prk", dh);
	const shared = labeledExpand(KEM_SUITE, eae, "shared_secret", Buffer.concat([enc, input.recipient]), 32);
	const context = Buffer.concat([
		Buffer.from([0]),
		labeledExtract(HPKE_SUITE, Buffer.alloc(0), "psk_id_hash", Buffer.alloc(0)),
		labeledExtract(HPKE_SUITE, Buffer.alloc(0), "info_hash", input.info),
	]);
	const secret = labeledExtract(HPKE_SUITE, shared, "secret", Buffer.alloc(0));
	const key = labeledExpand(HPKE_SUITE, secret, "key", context, 32);
	const nonce = labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce).setAAD(input.aad);
	const ct = Buffer.concat([cipher.update(input.plaintext), cipher.final(), cipher.getAuthTag()]);
	return { enc, ct };
}

/** `u32be(byteLength) || UTF-8(value) || zeros` to the next power of two, at least 256 bytes. */
export function pad(value: string): Buffer {
	const utf8 = Buffer.from(value, "utf8");
	let size = 256;
	while (size < 4 + utf8.length) size *= 2;
	const out = Buffer.alloc(size);
	out.writeUInt32BE(utf8.length, 0);
	utf8.copy(out, 4);
	return out;
}

type Request = Record<string, unknown>;

/** `req` from a received request, rebuilt from the design 4.2 formula. */
export function requestHash(request: Request, hostJkt: string): string {
	const displayHash = createHash("sha256")
		.update(JSON.stringify([request.title, request.placeholder ?? null]))
		.digest("base64url");
	const binding = [
		"omo-secret-binding-v1",
		request.hostInstance,
		hostJkt,
		request.durableSessionId,
		request.uiRequestId,
		request.deadlineAtMs,
		request.hpkePk,
		displayHash,
	];
	return createHash("sha256").update(JSON.stringify(binding)).digest("base64url");
}

export interface AnswerIds {
	readonly id: string;
	readonly req: string;
	readonly principalId: string;
	readonly grantId: string;
	readonly uiRequestId: string;
	readonly answerId: string;
}

const jtiOf = (stepup: string): string =>
	String(JSON.parse(Buffer.from(stepup.split(".")[1] ?? "", "base64url").toString("utf8")).jti);

/** A value answer frame (4.3), signed with the installation key. `plaintext` overrides the padded value. */
export function valueAnswer(
	ids: AnswerIds,
	request: Request,
	stepup: string,
	value: string,
	deviceKey: KeyObject,
	options: { readonly plaintext?: Buffer; readonly sealTo?: Buffer } = {},
): Record<string, unknown> {
	const jti = jtiOf(stepup);
	const info = Buffer.concat([
		Buffer.from("omo-secret-answer-v1"),
		Buffer.from([0]),
		Buffer.from(ids.req, "base64url"),
	]);
	const aad = Buffer.from(
		JSON.stringify(["omo-secret-answer-aad-v1", ids.req, ids.principalId, ids.grantId, ids.answerId, jti]),
	);
	const recipient = options.sealTo ?? Buffer.from(String(request.hpkePk), "base64url");
	const { enc, ct } = hpkeSeal({ recipient, info, aad, plaintext: options.plaintext ?? pad(value) });
	const sealed = createHash("sha256").update(enc).update(ct).digest("base64url");
	const transcript = `omo-secret-answer-v1\n${JSON.stringify([ids.req, ids.principalId, ids.grantId, ids.answerId, jti, sealed])}`;
	return {
		type: "mcp_presenter_secret_answer",
		id: ids.id,
		v: 1,
		grantId: ids.grantId,
		uiRequestId: ids.uiRequestId,
		answerId: ids.answerId,
		stepup,
		enc: enc.toString("base64url"),
		ct: ct.toString("base64url"),
		sig: sign(null, Buffer.from(transcript), deviceKey).toString("hex"),
	};
}

/** A cancel frame (4.3): no step-up, signed with the installation key. */
export function cancelAnswer(ids: AnswerIds, deviceKey: KeyObject): Record<string, unknown> {
	const transcript = `omo-secret-answer-v1\n${JSON.stringify([ids.req, ids.principalId, ids.grantId, ids.answerId, "cancel"])}`;
	return {
		type: "mcp_presenter_secret_answer",
		id: ids.id,
		v: 1,
		grantId: ids.grantId,
		uiRequestId: ids.uiRequestId,
		answerId: ids.answerId,
		cancelled: true,
		sig: sign(null, Buffer.from(transcript), deviceKey).toString("hex"),
	};
}
