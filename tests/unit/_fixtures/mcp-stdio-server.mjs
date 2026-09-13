/**
 * A minimal real MCP server over stdio, built on the SDK's own low-level
 * `Server`, for tests/unit/mcp-client-real-sdk.test.ts. Spawned as a subprocess
 * by the client under test, exactly as a configured stdio server would be.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
	{ name: 'stdio-fixture', version: '0.0.0' },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: 'echo',
			description: 'Echo the text back',
			inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	if (req.params.name !== 'echo') throw new Error(`unknown tool ${req.params.name}`);
	return { content: [{ type: 'text', text: `stdio:${String(req.params.arguments?.text)}` }] };
});

await server.connect(new StdioServerTransport());
