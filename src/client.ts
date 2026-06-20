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
    last_post_at?: number;
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

// ── activity digest ───────────────────────────────────────────────────────────

export interface ChannelActivity {
    channel: string; // human-friendly label (DM → @other, else display name)
    channel_id: string;
    type: string; // public | private | direct | group
    last_post_at: string; // ISO of the channel's most recent post
    count: number; // posts in the window (may exceed `posts.length` if capped)
    posts: FlatPost[];
}

const channelKind = (type: string): string =>
    type === 'O' ? 'public' : type === 'P' ? 'private' : type === 'D' ? 'direct' : type === 'G' ? 'group' : type;

/** Human label for a channel — DM → "@other", GM → display, else display/name. */
async function labelChannel(channel: MMChannel, meId: string, dmNames: Map<string, string>): Promise<string> {
    if (channel.type === 'D') {
        const otherId = channel.name.split('__').find((id) => id !== meId) ?? meId;
        let username = dmNames.get(otherId);
        if (!username) {
            username = (await resolveUser(otherId)).username;
            dmNames.set(otherId, username);
        }
        return `@${username}`;
    }
    if (channel.type === 'G') return channel.display_name || 'group message';
    return channel.display_name || channel.name;
}

/**
 * Catch-up digest: find conversations with activity since `sinceMs` and return
 * their recent messages grouped by channel, newest-active first. Cheap by
 * design — one channel-list call per team yields every channel's `last_post_at`,
 * so only channels actually active in the window incur a posts fetch. DM
 * channels are labelled with the other participant's @username.
 */
export async function getRecentActivity(opts: {
    sinceMs: number;
    teamIds?: string[];
    includeDms?: boolean;
    includeChannels?: boolean;
    onlyChannelIds?: string[];
    perChannel?: number;
}): Promise<ChannelActivity[]> {
    const me = await getMe();
    const includeDms = opts.includeDms ?? true;
    const includeChannels = opts.includeChannels ?? false;
    const perChannel = opts.perChannel ?? 50;
    const teamIds = opts.teamIds ?? (await mm<MMTeam[]>('GET', '/users/me/teams')).map((t) => t.id);

    // Every channel the user belongs to (DMs/GMs included), deduped across teams.
    const byId = new Map<string, MMChannel>();
    for (const teamId of teamIds) {
        const channels = await mm<MMChannel[]>('GET', `/users/${me.id}/teams/${teamId}/channels`);
        for (const channel of channels) byId.set(channel.id, channel);
    }

    // Selection: explicit channels (if given) stand in for the regular-channel
    // set; DMs/GMs are layered on top whenever includeDms is set.
    const selected = new Map<string, MMChannel>();
    if (opts.onlyChannelIds && opts.onlyChannelIds.length > 0) {
        for (const id of opts.onlyChannelIds) {
            const channel = byId.get(id) ?? (await mm<MMChannel>('GET', `/channels/${id}`));
            selected.set(channel.id, channel);
        }
    } else if (includeChannels) {
        for (const channel of byId.values()) {
            if (channel.type === 'O' || channel.type === 'P') selected.set(channel.id, channel);
        }
    }
    if (includeDms) {
        for (const channel of byId.values()) {
            if (channel.type === 'D' || channel.type === 'G') selected.set(channel.id, channel);
        }
    }

    // Only channels active within the window, most-recently-active first.
    const active = [...selected.values()]
        .filter((channel) => (channel.last_post_at ?? 0) >= opts.sinceMs)
        .sort((a, b) => (b.last_post_at ?? 0) - (a.last_post_at ?? 0));

    const dmNames = new Map<string, string>(); // userId → username, for DM labels
    const digest: ChannelActivity[] = [];
    for (const channel of active) {
        const list = await mm<MMPostList>('GET', `/channels/${channel.id}/posts`, {query: {since: opts.sinceMs}});
        const posts = await flattenPosts(list);
        if (posts.length === 0) continue;
        digest.push({
            channel: await labelChannel(channel, me.id, dmNames),
            channel_id: channel.id,
            type: channelKind(channel.type),
            last_post_at: new Date(channel.last_post_at ?? 0).toISOString(),
            count: posts.length,
            posts: posts.slice(-perChannel),
        });
    }
    return digest;
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
