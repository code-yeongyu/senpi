import type { RpcAttachmentResponse } from "./attachment-types.ts";

import type { RpcHostCommandResponse } from "./rpc-host-response-types.ts";
import type { RpcMutationResponse } from "./rpc-mutation-response-types.ts";
import type { RpcPauseResponse } from "./rpc-pause-response-types.ts";
import type { RpcReadResponse } from "./rpc-read-response-types.ts";
export type RpcResponse =
	| RpcAttachmentResponse
	| RpcHostCommandResponse
	| RpcReadResponse
	| RpcMutationResponse
	| RpcPauseResponse;
