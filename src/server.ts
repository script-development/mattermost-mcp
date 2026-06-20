import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';

import {
    downloadFile,
    flattenPosts,
    getMe,
    mm,
    resolveChannelId,
    resolveTeamId,
    resolveUser,
    uploadFile,
    type MMChannel,
    type MMPost,
    type MMPostList,
    type MMTeam,
} from './client.js';

/**
 * Build the Mattermost MCP server and register every tool. The server is
 * stateless beyond the per-process caches in client.ts — identity comes from
 * the PAT, so there is nothing to bind per request.
 */
export function buildServer(): McpServer {
    const server = new McpServer({name: 'mattermost-mcp', version: '0.1.0'});

    type Result = {content: Array<{type: 'text'; text: string}>; isError?: boolean};
    const ok = (data: unknown): Result => ({
        content: [{type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2)}],
    });
    const fail = (error: unknown): Result => ({
        content: [{type: 'text', text: `Error: ${(error as Error).message}`}],
        isError: true,
    });
    // Run a tool body, turning any throw into a clean isError result rather than
    // a transport-level fault the client sees as a crash.
    const run = async (fn: () => Promise<unknown>): Promise<Result> => {
        try {
            return ok(await fn());
        } catch (error) {
            return fail(error);
        }
    };

    // A (team, channel) pair accepted by every channel-scoped tool. `channel_id`
    // wins if given; otherwise `team` + `channel` (URL slug) are resolved.
    const channelTarget = {
        channel_id: z.string().optional().describe('Channel ID (26-char). Takes precedence over team+channel.'),
        team: z.string().optional().describe('Team name (URL slug) or ID — required if using channel name.'),
        channel: z
            .string()
            .optional()
            .describe('Channel URL slug (not display name) or ID. Use search_channels to find a slug.'),
    } as const;

    // ── identity & discovery ──────────────────────────────────────────────

    server.registerTool(
        'whoami',
        {
            title: 'Who am I',
            description: 'Return the Mattermost user this token acts as (id, username, email, roles).',
            inputSchema: {},
        },
        async () => run(() => getMe()),
    );

    server.registerTool(
        'list_teams',
        {title: 'List my teams', description: 'List the teams the authenticated user is a member of.', inputSchema: {}},
        async () =>
            run(async () => {
                const teams = await mm<MMTeam[]>('GET', '/users/me/teams');
                return teams.map((t) => ({id: t.id, name: t.name, display_name: t.display_name, type: t.type}));
            }),
    );

    server.registerTool(
        'list_channels',
        {
            title: 'List channels in a team',
            description: 'List the channels the authenticated user belongs to in a given team.',
            inputSchema: {team: z.string().describe('Team name (URL slug) or ID')},
        },
        async ({team}) =>
            run(async () => {
                const me = await getMe();
                const teamId = await resolveTeamId(team);
                const channels = await mm<MMChannel[]>('GET', `/users/${me.id}/teams/${teamId}/channels`);
                return channels.map((c) => ({id: c.id, name: c.name, display_name: c.display_name, type: c.type}));
            }),
    );

    server.registerTool(
        'search_channels',
        {
            title: 'Search channels',
            description:
                'Find channels in a team by a search term (matches name and display name). Returns slugs you can pass as `channel`.',
            inputSchema: {
                team: z.string().describe('Team name (URL slug) or ID'),
                term: z.string().describe('Search term'),
            },
        },
        async ({team, term}) =>
            run(async () => {
                const teamId = await resolveTeamId(team);
                const channels = await mm<MMChannel[]>('POST', `/teams/${teamId}/channels/search`, {body: {term}});
                return channels.map((c) => ({id: c.id, name: c.name, display_name: c.display_name, type: c.type}));
            }),
    );

    server.registerTool(
        'get_user',
        {
            title: 'Get a user',
            description: 'Look up a Mattermost user by @username or ID.',
            inputSchema: {user: z.string().describe('Username (without @) or user ID')},
        },
        async ({user}) => run(() => resolveUser(user)),
    );

    // ── reading ───────────────────────────────────────────────────────────

    server.registerTool(
        'get_channel_posts',
        {
            title: 'Read a channel',
            description: 'Read recent posts in a channel, oldest→newest, with author usernames resolved.',
            inputSchema: {
                ...channelTarget,
                per_page: z.number().int().min(1).max(200).optional().describe('Posts to fetch (default 30, max 200)'),
                page: z.number().int().min(0).optional().describe('Page offset for older posts (default 0)'),
            },
        },
        async (args) =>
            run(async () => {
                const channelId = await resolveChannelId(args);
                const list = await mm<MMPostList>('GET', `/channels/${channelId}/posts`, {
                    query: {per_page: args.per_page ?? 30, page: args.page ?? 0},
                });
                return flattenPosts(list);
            }),
    );

    server.registerTool(
        'get_thread',
        {
            title: 'Read a thread',
            description: 'Read a full thread (the root post and all replies) given any post ID in it.',
            inputSchema: {post_id: z.string().describe('Any post ID within the thread')},
        },
        async ({post_id}) =>
            run(async () => {
                const list = await mm<MMPostList>('GET', `/posts/${post_id}/thread`);
                return flattenPosts(list);
            }),
    );

    server.registerTool(
        'search_posts',
        {
            title: 'Search messages',
            description:
                'Full-text search posts within a team. Supports Mattermost search modifiers (from:, in:, on:, "quoted phrase").',
            inputSchema: {
                team: z.string().describe('Team name (URL slug) or ID to search within'),
                terms: z.string().describe('Search terms / query'),
                or_search: z.boolean().optional().describe('Match ANY term instead of ALL (default false)'),
            },
        },
        async ({team, terms, or_search}) =>
            run(async () => {
                const teamId = await resolveTeamId(team);
                const list = await mm<MMPostList>('POST', `/teams/${teamId}/posts/search`, {
                    body: {terms, is_or_search: Boolean(or_search)},
                });
                return flattenPosts(list);
            }),
    );

    // ── writing ───────────────────────────────────────────────────────────

    server.registerTool(
        'post_message',
        {
            title: 'Post a message',
            description: 'Post a message to a channel. Set root_id to reply within an existing thread.',
            inputSchema: {
                ...channelTarget,
                message: z.string().describe('Message text (Markdown supported)'),
                root_id: z.string().optional().describe('Root post ID to thread under (omit for a new top-level post)'),
            },
        },
        async (args) =>
            run(async () => {
                const channelId = await resolveChannelId(args);
                return mm<MMPost>('POST', '/posts', {
                    body: {channel_id: channelId, message: args.message, root_id: args.root_id ?? ''},
                });
            }),
    );

    server.registerTool(
        'reply_to_thread',
        {
            title: 'Reply in a thread',
            description: 'Reply to a thread given the root (or any) post ID — the channel is resolved automatically.',
            inputSchema: {
                root_id: z.string().describe('The post ID to reply under'),
                message: z.string().describe('Reply text (Markdown supported)'),
            },
        },
        async ({root_id, message}) =>
            run(async () => {
                const root = await mm<MMPost>('GET', `/posts/${root_id}`);
                // Thread under the actual root even if root_id pointed at a reply.
                const threadRoot = root.root_id && root.root_id !== '' ? root.root_id : root.id;
                return mm<MMPost>('POST', '/posts', {
                    body: {channel_id: root.channel_id, message, root_id: threadRoot},
                });
            }),
    );

    server.registerTool(
        'update_post',
        {
            title: 'Edit a post',
            description: 'Edit the text of an existing post (you must own it, or be an admin).',
            inputSchema: {
                post_id: z.string().describe('The post ID to edit'),
                message: z.string().describe('New message text'),
            },
        },
        async ({post_id, message}) => run(() => mm<MMPost>('PUT', `/posts/${post_id}/patch`, {body: {message}})),
    );

    server.registerTool(
        'delete_post',
        {
            title: 'Delete a post',
            description: 'Delete a post (you must own it, or be an admin).',
            inputSchema: {post_id: z.string().describe('The post ID to delete')},
        },
        async ({post_id}) =>
            run(async () => {
                await mm('DELETE', `/posts/${post_id}`);
                return {deleted: post_id};
            }),
    );

    server.registerTool(
        'send_direct_message',
        {
            title: 'Send a direct message',
            description: 'Open (or reuse) a DM channel with a user and post a message to it.',
            inputSchema: {
                user: z.string().describe('Recipient username (without @) or user ID'),
                message: z.string().describe('Message text (Markdown supported)'),
            },
        },
        async ({user, message}) =>
            run(async () => {
                const me = await getMe();
                const target = await resolveUser(user);
                const dm = await mm<MMChannel>('POST', '/channels/direct', {body: [me.id, target.id]});
                return mm<MMPost>('POST', '/posts', {body: {channel_id: dm.id, message}});
            }),
    );

    // ── reactions ─────────────────────────────────────────────────────────

    server.registerTool(
        'add_reaction',
        {
            title: 'Add a reaction',
            description: 'Add an emoji reaction to a post. Use the emoji name without colons, e.g. "thumbsup".',
            inputSchema: {
                post_id: z.string().describe('The post ID to react to'),
                emoji: z.string().describe('Emoji name without colons, e.g. "tada"'),
            },
        },
        async ({post_id, emoji}) =>
            run(async () => {
                const me = await getMe();
                return mm('POST', '/reactions', {body: {user_id: me.id, post_id, emoji_name: emoji}});
            }),
    );

    server.registerTool(
        'remove_reaction',
        {
            title: 'Remove a reaction',
            description: 'Remove one of your emoji reactions from a post.',
            inputSchema: {
                post_id: z.string().describe('The post ID'),
                emoji: z.string().describe('Emoji name without colons'),
            },
        },
        async ({post_id, emoji}) =>
            run(async () => {
                const me = await getMe();
                await mm('DELETE', `/users/${me.id}/posts/${post_id}/reactions/${encodeURIComponent(emoji)}`);
                return {removed: emoji, post_id};
            }),
    );

    // ── files ─────────────────────────────────────────────────────────────

    server.registerTool(
        'post_file',
        {
            title: 'Upload and post a file',
            description: 'Upload a local file to a channel and post it, optionally with a message.',
            inputSchema: {
                ...channelTarget,
                path: z.string().describe('Absolute path to the local file to upload'),
                message: z.string().optional().describe('Optional message to accompany the file'),
                filename: z.string().optional().describe('Override the displayed filename'),
            },
        },
        async (args) =>
            run(async () => {
                const channelId = await resolveChannelId(args);
                const fileId = await uploadFile(channelId, args.path, args.filename);
                return mm<MMPost>('POST', '/posts', {
                    body: {channel_id: channelId, message: args.message ?? '', file_ids: [fileId]},
                });
            }),
    );

    server.registerTool(
        'download_file',
        {
            title: 'Download a file',
            description: 'Download a file attachment (by its file_id, found on a post) to a local path.',
            inputSchema: {
                file_id: z.string().describe("The file ID (from a post's file_ids)"),
                save_to: z.string().describe('Absolute local path to write the file to'),
            },
        },
        async ({file_id, save_to}) =>
            run(async () => {
                const bytes = await downloadFile(file_id, save_to);
                return {saved: save_to, bytes};
            }),
    );

    // ── channel management ────────────────────────────────────────────────

    server.registerTool(
        'create_channel',
        {
            title: 'Create a channel',
            description: 'Create a new channel in a team. `name` is the URL slug (lowercase, no spaces).',
            inputSchema: {
                team: z.string().describe('Team name (URL slug) or ID'),
                name: z.string().describe('Channel URL slug (lowercase, hyphenated)'),
                display_name: z.string().describe('Human-readable channel name'),
                type: z.enum(['public', 'private']).optional().describe('Channel visibility (default public)'),
                purpose: z.string().optional().describe('Optional channel purpose'),
            },
        },
        async ({team, name, display_name, type, purpose}) =>
            run(async () => {
                const teamId = await resolveTeamId(team);
                return mm<MMChannel>('POST', '/channels', {
                    body: {
                        team_id: teamId,
                        name,
                        display_name,
                        type: type === 'private' ? 'P' : 'O',
                        purpose: purpose ?? '',
                    },
                });
            }),
    );

    server.registerTool(
        'join_channel',
        {
            title: 'Join a channel',
            description: 'Add the authenticated user as a member of a channel.',
            inputSchema: channelTarget,
        },
        async (args) =>
            run(async () => {
                const me = await getMe();
                const channelId = await resolveChannelId(args);
                return mm('POST', `/channels/${channelId}/members`, {body: {user_id: me.id}});
            }),
    );

    return server;
}
