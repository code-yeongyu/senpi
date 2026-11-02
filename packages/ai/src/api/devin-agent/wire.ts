/** Cascade wire surface: paths, identity metadata, frame codec, unary RPCs and request building. */

export { type DevinFrame, decodeDevinFrames, encodeDevinFrame as encodeDevinRequestFrame } from "./frames.ts";
export {
	DEVIN_CLI_IDENTITY,
	DEVIN_DISCOVERY_IDENTITY,
	DEVIN_SUPPORTED_MODEL_DISPLAYS,
	devinCliMetadata,
	devinDiscoveryMetadata,
	normalizeDevinSessionToken,
} from "./metadata.ts";
export {
	DEVIN_ASSIGN_MODEL_PATH,
	DEVIN_CHAT_HEADERS,
	DEVIN_CHAT_MESSAGE_PATH,
	DEVIN_CLI_MODEL_CONFIGS_PATH,
	DEVIN_DEFAULT_BASE_URL,
	DEVIN_MAX_FRAME_PAYLOAD,
	DEVIN_UNARY_HEADERS,
	DEVIN_USER_JWT_PATH,
} from "./paths.ts";
export {
	buildDevinChatRequest,
	buildDevinRouterPrompt,
	DEVIN_DEFAULT_STOP_PATTERNS,
	type DevinChatRequestInput,
	type DevinModelAssignment,
} from "./request.ts";
export { type DevinTrailerError, readDevinTrailerError } from "./trailer.ts";
export { DevinUnaryError, type DevinUnaryInput, decodeDevinUnary, postDevinUnary } from "./unary.ts";
