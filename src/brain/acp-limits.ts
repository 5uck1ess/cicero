/** Maximum unread ACP text retained for one streaming consumer. */
export const DEFAULT_ACP_QUEUE_LIMIT_BYTES = 256 * 1024;
/** Maximum text accumulated by the non-streaming send() convenience method. */
export const DEFAULT_ACP_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
/** Config validation ceiling for either in-memory ACP limit. */
export const MAX_ACP_TEXT_LIMIT_BYTES = 64 * 1024 * 1024;
/** Maximum one-line JSON-RPC frame accepted from an ACP agent. */
export const DEFAULT_ACP_FRAME_LIMIT_BYTES = 1024 * 1024;
/** Maximum active + queued turns admitted to one stateful ACP session. */
export const DEFAULT_ACP_PENDING_TURN_LIMIT = 32;
export const MAX_ACP_PENDING_TURN_LIMIT = 1024;
