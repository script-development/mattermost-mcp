import {readFile, writeFile} from 'node:fs/promises';
import {basename} from 'node:path';

import {config} from './config.js';

/**
 * A thin typed wrapper over the Mattermost REST API v4. Every request carries
 * the PAT, so all of this acts as the token owner. Resolver helpers let tools
 * accept human-friendly names (team slug, channel slug, @username) instead of
 * 26-char IDs, with light per-process caching so a busy session doesn't re-hit
 * the same lookups.
 */

// Mattermost IDs are 26-char lowercase base32. Anything matching this we treat
// as an already-resolved ID and pass straight through (skip the name lookup).
const ID_RE = /^[a-z0-9]{26}$/;
export const looksLikeId = (value: string): boolean => ID_RE.test(value);

export interface MMUser {
    id: string;
    username: string;
    email?: string;
    nickname?: string;
    first_name?: string;
    last_name?: string;
    position?: string;
    roles?: string;
}

export interface MMTeam {
    id: string;
    name: string;
    display_name: string;
    type: string;
}

export interface MMChannel {
    id: string;
    name: string;
    display_name: string;
    type: string;
    purpose?: string;
    team_id?: string;
}

export interface MMPost {
    id: string;
    create_at: number;
    user_id: string;
    channel_id: string;
    root_id: string;
    message: string;
    type: string;
    file_ids?: string[];
}

export interface MMPostList {
    order: string[];
    posts: Record<string, MMPost>;
}

type Query = Record<string, string | number | boolean | undefined>;

/**
 * Core request. Throws a descriptive Error on any non-2xx, preferring the
 * Mattermost error body's `message` over a bare status line so a tool surfaces
 * "You do not have the appropriate permissions" rather than just "403".
 */
export async function mm<T>(method: string, path: string, opts: {body?: unknown; query?: Query} = {}): Promise<T> {
    const query = opts.query
        ? Object.entries(opts.query)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        : [];
    const qs = query.length > 0 ? `?${query.join('&')}` : '';

    const response = await fetch(`${config.apiBase}${path}${qs}`, {
        method,
        headers: {
            Authorization: `Bearer ${config.token}`,
            ...(opts.body === undefined ? {} : {'Content-Type': 'application/json'}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    if (!response.ok) {
        let detail = response.statusText;
        try {
            const err = (await response.json()) as {message?: string};
            if (err.message) detail = err.message;
        } catch {
            // No JSON body — keep the status line.
        }
        throw new Error(`Mattermost ${method} ${path} → ${response.status}: ${detail}`);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
}

// ── identity ────────────────────────────────────────────────────────────────

let cachedMe: MMUser | undefined;
export async function getMe(): Promise<MMUser> {
    if (!cachedMe) cachedMe = await mm<MMUser>('GET', '/users/me');
    return cachedMe;
}

// ── resolvers ───────────────────────────────────────────────────────────────

const teamCache = new Map<string, string>();
export async function resolveTeamId(team: string): Promise<string> {
    if (looksLikeId(team)) return team;
    const cached = teamCache.get(team);
    if (cached) return cached;
    const resolved = await mm<MMTeam>('GET', `/teams/name/${encodeURIComponent(team)}`);
    teamCache.set(team, resolved.id);
    return resolved.id;
}

/**
 * Resolve a channel from either an explicit `channel_id`, or a (team, channel)
 * pair where `channel` is the channel's URL slug (its `name`, not the pretty
 * display name — use `search_channels` to find a slug from a display name).
 */
export async function resolveChannelId(args: {channel_id?: string; team?: string; channel?: string}): Promise<string> {
    if (args.channel_id) return args.channel_id;
    if (!args.team || !args.channel) {
        throw new Error('Provide either channel_id, or both team and channel (the channel URL slug).');
    }
    if (looksLikeId(args.channel)) return args.channel;
    const teamId = await resolveTeamId(args.team);
    const channel = await mm<MMChannel>('GET', `/teams/${teamId}/channels/name/${encodeURIComponent(args.channel)}`);
    return channel.id;
}

export async function resolveUser(user: string): Promise<MMUser> {
    if (looksLikeId(user)) return mm<MMUser>('GET', `/users/${user}`);
    return mm<MMUser>('GET', `/users/username/${encodeURIComponent(user)}`);
}

/** Batch-resolve user IDs → usernames in one call, for labelling post authors. */
async function usernamesFor(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    const map = new Map<string, string>();
    if (unique.length === 0) return map;
    const users = await mm<MMUser[]>('POST', '/users/ids', {body: unique});
    for (const user of users) map.set(user.id, user.username);
    return map;
}

// ── formatting ──────────────────────────────────────────────────────────────

export interface FlatPost {
    id: string;
    user: string;
    at: string;
    message: string;
    root_id?: string;
    file_ids?: string[];
}

/**
 * Flatten Mattermost's {order, posts} envelope into a chronological array
 * (oldest → newest, the natural reading order) with author usernames resolved
 * and epoch-ms timestamps rendered as ISO strings.
 */
export async function flattenPosts(list: MMPostList): Promise<FlatPost[]> {
    const order = list.order ?? [];
    const authorIds = order.map((id) => list.posts[id]?.user_id).filter((v): v is string => Boolean(v));
    const names = await usernamesFor(authorIds);

    return [...order].reverse().flatMap((id) => {
        const post = list.posts[id];
        if (!post) return [];
        return [
            {
                id: post.id,
                user: names.get(post.user_id) ?? post.user_id,
                at: new Date(post.create_at).toISOString(),
                message: post.message,
                ...(post.root_id ? {root_id: post.root_id} : {}),
                ...(post.file_ids && post.file_ids.length > 0 ? {file_ids: post.file_ids} : {}),
            },
        ];
    });
}

// ── files ───────────────────────────────────────────────────────────────────

/** Upload a local file to a channel; returns the new file_id to attach to a post. */
export async function uploadFile(channelId: string, filePath: string, filename?: string): Promise<string> {
    const data = await readFile(filePath);
    const form = new FormData();
    form.set('channel_id', channelId);
    form.set('files', new Blob([data]), filename ?? basename(filePath));

    const response = await fetch(`${config.apiBase}/files`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${config.token}`},
        body: form,
    });
    if (!response.ok) {
        throw new Error(`Mattermost POST /files → ${response.status}: ${await response.text()}`);
    }
    const result = (await response.json()) as {file_infos?: Array<{id: string}>};
    const fileId = result.file_infos?.[0]?.id;
    if (!fileId) throw new Error('Upload succeeded but returned no file id.');
    return fileId;
}

/** Download a file by id to a local path; returns the byte count written. */
export async function downloadFile(fileId: string, saveTo: string): Promise<number> {
    const response = await fetch(`${config.apiBase}/files/${fileId}`, {
        headers: {Authorization: `Bearer ${config.token}`},
    });
    if (!response.ok) {
        throw new Error(`Mattermost GET /files/${fileId} → ${response.status}: ${response.statusText}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(saveTo, bytes);
    return bytes.length;
}
