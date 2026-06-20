/**
 * Read-only integration smoke test. Exercises the client layer end-to-end
 * against the live Mattermost server using MM_URL + MM_TOKEN from .env. Posts
 * nothing — only GETs identity, teams, and the channels of the first team.
 *
 *   npm run smoke
 */
import {getMe, mm, type MMChannel, type MMTeam} from '../src/client.js';

async function main(): Promise<void> {
    const me = await getMe();
    console.log(`✓ whoami: ${me.username} <${me.email ?? '?'}> roles=${me.roles ?? '?'}`);

    const teams = await mm<MMTeam[]>('GET', '/users/me/teams');
    console.log(`✓ teams (${teams.length}): ${teams.map((t) => t.name).join(', ') || '(none)'}`);

    const first = teams[0];
    if (first) {
        const channels = await mm<MMChannel[]>('GET', `/users/${me.id}/teams/${first.id}/channels`);
        console.log(
            `✓ channels in "${first.name}" (${channels.length}): ${channels
                .slice(0, 10)
                .map((c) => c.name)
                .join(', ')}${channels.length > 10 ? ', …' : ''}`,
        );
    }

    console.log('\nSmoke test passed — client layer talks to Mattermost.');
}

main().catch((error: unknown) => {
    console.error('✗ smoke test failed:', (error as Error).message);
    process.exit(1);
});
