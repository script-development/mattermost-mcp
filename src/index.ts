import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';

import {buildServer} from './server.js';

/**
 * Entry point. A stdio MCP server — the client (Claude Code via .mcp.json)
 * launches this process and speaks MCP over stdin/stdout. Identity is the PAT
 * in MM_TOKEN, so there is no handshake to manage beyond connecting the
 * transport. Keep stdout clean for the protocol; diagnostics go to stderr.
 */
async function main(): Promise<void> {
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('mattermost-mcp: connected over stdio');
}

main().catch((error: unknown) => {
    console.error('mattermost-mcp: fatal', error);
    process.exit(1);
});
