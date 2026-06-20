/**
 * MCP protocol handshake test. Spawns the BUILT server over stdio exactly as an
 * MCP client (Claude Code) would, completes the initialize handshake, and lists
 * the registered tools. Proves the server speaks MCP and every tool registered
 * cleanly — without calling any write tools against the live server.
 *
 *   npm run build && npm run handshake
 */
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

async function main(): Promise<void> {
    const transport = new StdioClientTransport({
        command: 'node',
        args: ['dist/index.js'],
        env: {MM_URL: process.env.MM_URL ?? '', MM_TOKEN: process.env.MM_TOKEN ?? '', PATH: process.env.PATH ?? ''},
    });
    const client = new Client({name: 'handshake-test', version: '0'});
    await client.connect(transport);

    const {tools} = await client.listTools();
    console.log(`✓ handshake OK — server exposes ${tools.length} tools:`);
    for (const tool of tools) console.log(`   • ${tool.name} — ${tool.description ?? ''}`);

    // Exercise one read-only tool through the actual MCP round-trip.
    const who = await client.callTool({name: 'whoami', arguments: {}});
    const text = Array.isArray(who.content) && who.content[0]?.type === 'text' ? who.content[0].text : '';
    const username = (JSON.parse(text) as {username?: string}).username ?? '?';
    console.log(`\n✓ whoami round-trip via MCP: ${username}`);

    await client.close();
    console.log('\nHandshake test passed — the MCP server works over stdio.');
}

main().catch((error: unknown) => {
    console.error('✗ handshake failed:', (error as Error).message);
    process.exit(1);
});
