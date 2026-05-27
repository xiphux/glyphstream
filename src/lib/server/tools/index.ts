/**
 * Tool registry barrel. Importing this module triggers all built-in tool
 * registrations as a side-effect — server-side entry points that need
 * the registry populated (the chat completion handler, the streaming
 * relay) should import from here, not directly from `./registry`.
 *
 * To add a new built-in tool: create `./<name>.ts` that calls
 * `register(...)` at module scope, then add a `import './<name>';`
 * line below. Order doesn't matter; the registry just collects them.
 */

import './clock';
import './fetch-url';

export { get, list, openaiToolDefinitions, register } from './registry';
export type { OpenAIToolDefinition, Tool, ToolContext, ToolExecution, ToolMetadata } from './types';
