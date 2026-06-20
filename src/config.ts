/**
 * Configuration is read once from the environment. Two values, both required:
 *
 *   MM_URL    Base URL of the Mattermost server, e.g. https://chat.script.nl
 *             (no trailing /api/v4 — we append it).
 *   MM_TOKEN  A Mattermost Personal Access Token. Every API call carries it as
 *             `Authorization: Bearer <token>`, so the MCP acts as whoever owns
 *             the token. Each user runs their own copy with their own PAT.
 *
 * When launched from an MCP client (.mcp.json) these arrive in the `env` block.
 * For local `npm run dev` / `smoke` they come from a gitignored .env file.
 */

function required(name: string): string {
    const value = process.env[name];
    if (!value || value.trim() === '') {
        throw new Error(`${name} must be set (see .env.example).`);
    }
    return value.trim();
}

const baseUrl = required('MM_URL').replace(/\/+$/, '');

export const config = {baseUrl, apiBase: `${baseUrl}/api/v4`, token: required('MM_TOKEN')} as const;
