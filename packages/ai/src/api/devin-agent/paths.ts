/**
 * Cascade RPC paths and wire constants.
 *
 * Devin's released CLI speaks the Connect protocol over HTTP/1.1 against
 * Codeium's Cascade edge. The service paths are spelled out here rather than
 * derived from a generated service descriptor: the vendored schema in
 * packages/ai/proto/devin/cascade.proto carries only the message subset the
 * transport needs, so its package name is cosmetic while these paths are the
 * real contract.
 */

export const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";
export const DEVIN_CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
export const DEVIN_CLI_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
export const DEVIN_ASSIGN_MODEL_PATH = "/exa.api_server_pb.ApiServerService/AssignModel";
export const DEVIN_USER_JWT_PATH = "/exa.auth_pb.AuthService/GetUserJwt";

/**
 * Request headers the released CLI sends on the streaming chat call. Auth rides
 * inside `Metadata.api_key`, so there is no `authorization` header.
 */
export const DEVIN_CHAT_HEADERS = {
	"content-type": "application/connect+proto",
	"connect-protocol-version": "1",
	"connect-content-encoding": "gzip",
	"accept-encoding": "identity",
	"user-agent": "connect-go/1.18.1 (go1.26.3)",
	"connect-accept-encoding": "gzip",
} as const;

/** Unary Connect calls carry a bare protobuf body, not the 5-byte streaming frame. */
export const DEVIN_UNARY_HEADERS = {
	"content-type": "application/proto",
	"connect-protocol-version": "1",
	accept: "*/*",
} as const;

/** Connect frame flags: bit 0 marks a gzipped payload, bit 1 the end-of-stream trailer. */
export const DEVIN_COMPRESSED_FLAG = 0x01;
export const DEVIN_TRAILER_FLAG = 0x02;

/**
 * Hard upper bound on one Connect frame payload. The 4-byte length prefix can
 * describe 4 GiB; a corrupted or hostile prefix must not turn into an
 * allocation of that size, so anything larger is a protocol error.
 */
export const DEVIN_MAX_FRAME_PAYLOAD = 64 * 1024 * 1024;
