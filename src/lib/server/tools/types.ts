/**
 * Tool registry types. The Tool interface is the contract every registered
 * tool implements — built-in tools (clock, future web_search, etc.) and,
 * later, MCP-discovered tools that proxy to remote servers.
 *
 * `definition` is what we send upstream to the model (straight OpenAI
 * tools[] shape). `execute` is what we run when the model calls it.
 * `metadata` is UI-only and never crosses the wire.
 */

/** OpenAI tools[] entry. See https://platform.openai.com/docs/api-reference/chat/create#chat-create-tools */
export interface OpenAIToolDefinition {
	type: 'function';
	function: {
		name: string;
		description: string;
		/** JSON Schema describing the function's parameters. */
		parameters: Record<string, unknown>;
	};
}

/**
 * Per-call context passed to `execute`. Carries identity (so tools can
 * scope to the user / conversation) and an AbortSignal so long-running
 * tools cooperate with turn cancellation.
 */
export interface ToolContext {
	userId: string;
	conversationId: string;
	signal: AbortSignal;
}

/**
 * The result of a tool invocation. `content` is sent back to the model
 * as the `tool` message body — must be a string per OpenAI spec; tools
 * returning structured data should JSON.stringify it themselves.
 *
 * `isError: true` is fed back to the model (it can apologize / retry)
 * rather than aborting the turn. The UI flags it visually so users see
 * which calls failed.
 */
export interface ToolExecution {
	content: string;
	isError?: boolean;
}

/**
 * Optional UI-only metadata. Never sent upstream. `displayLabel` is a
 * future hook for showing "Clock" alongside `get_current_time` if the
 * raw function name proves too cryptic for some tools — v1 renders the
 * raw name only.
 */
export interface ToolMetadata {
	displayLabel?: string;
	icon?: string;
}

export interface Tool {
	definition: OpenAIToolDefinition;
	metadata?: ToolMetadata;
	execute(args: unknown, ctx: ToolContext): Promise<ToolExecution> | ToolExecution;
}
