import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CHANNEL = 'helbbiz';
const HELIX = 'https://api.twitch.tv/helix';
const cache = new Map();
let accessToken;
let tokenExpiresAt = 0;
let tokenRequest;

class TwitchApiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function allowedOrigins() {
  const configured = (process.env.FRONTEND_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return new Set([
    'https://helbizttv.onrender.com',
    'https://helbbiz-sitev3-1.onrender.com',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:8765',
    'http://127.0.0.1:8765',
    ...configured
  ]);
}

function sendJson(response, status, payload, origin) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {})
  });
  response.end(JSON.stringify(payload));
}

async function cached(key, ttlMs, load) {
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) return current.value;
  const value = await load();
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

async function twitchToken() {
  if (accessToken && tokenExpiresAt > Date.now() + 60000) return accessToken;
  if (tokenRequest) return tokenRequest;
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new TwitchApiError('Twitch API credentials are not configured.', 503);
  }

  tokenRequest = (async () => {
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials'
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new TwitchApiError(`Twitch token request failed (${response.status}).`);
    const result = await response.json();
    if (typeof result.access_token !== 'string' || !Number.isFinite(result.expires_in)) {
      throw new TwitchApiError('Twitch returned an invalid application token response.');
    }
    accessToken = result.access_token;
    tokenExpiresAt = Date.now() + result.expires_in * 1000;
    return accessToken;
  })().finally(() => {
    tokenRequest = undefined;
  });
  return tokenRequest;
}

async function twitchGet(endpoint, { includePagination = false } = {}) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const token = await twitchToken();
  const response = await fetch(`${HELIX}${endpoint}`, {
    headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new TwitchApiError(`Twitch API request failed (${response.status}).`);
  const result = await response.json();
  if (!Array.isArray(result.data)) throw new TwitchApiError('Twitch returned an invalid API response.');
  return includePagination
    ? { data: result.data, cursor: result.pagination?.cursor || null }
    : result.data;
}

function twitchUser() {
  return cached('user', 60 * 60 * 1000, async () => {
    const users = await twitchGet(`/users?login=${encodeURIComponent(CHANNEL)}`);
    if (!users[0]?.id) throw new TwitchApiError('The Twitch channel could not be found.');
    return users[0];
  });
}

async function streamStatus() {
  return cached('stream', 30000, async () => {
    const streams = await twitchGet(`/streams?user_login=${encodeURIComponent(CHANNEL)}&first=1`);
    const stream = streams[0];
    if (!stream) return { available: true, live: false, stream: null };
    return {
      available: true,
      live: true,
      stream: {
        title: stream.title,
        gameName: stream.game_name,
        viewerCount: stream.viewer_count,
        startedAt: stream.started_at
      }
    };
  });
}

async function recentClips(first, after) {
  const cacheKey = `clips:${first}:${after || 'first'}`;
  return cached(cacheKey, 5 * 60 * 1000, async () => {
    const user = await twitchUser();
    const query = new URLSearchParams({
      broadcaster_id: user.id,
      first: String(first)
    });
    if (after) query.set('after', after);
    const result = await twitchGet(`/clips?${query}`, { includePagination: true });
    const gameIds = [...new Set(result.data.map(clip => clip.game_id).filter(Boolean))];
    const games = gameIds.length
      ? await twitchGet(`/games?${gameIds.map(id => `id=${encodeURIComponent(id)}`).join('&')}`)
      : [];
    const gameNames = new Map(games.map(game => [game.id, game.name]));
    return {
      available: true,
      clips: result.data.map(clip => ({
        id: clip.id,
        title: clip.title,
        url: clip.url,
        thumbnailUrl: clip.thumbnail_url,
        viewCount: clip.view_count,
        createdAt: clip.created_at,
        gameName: gameNames.get(clip.game_id) || null
      })),
      cursor: result.cursor
    };
  });
}

function schedule() {
  const startAt = process.env.NEXT_STREAM_AT;
  if (!startAt) return { available: false, fixed: false };
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(startAt) || !Number.isFinite(Date.parse(startAt))) {
    throw new TwitchApiError('NEXT_STREAM_AT must be a valid ISO date with a timezone.', 503);
  }
  const durationMinutes = Number(process.env.NEXT_STREAM_DURATION_MINUTES || 180);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 720) {
    throw new TwitchApiError('NEXT_STREAM_DURATION_MINUTES must be between 15 and 720.', 503);
  }
  const timezone = process.env.NEXT_STREAM_TIMEZONE || 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new TwitchApiError('NEXT_STREAM_TIMEZONE must be a valid IANA timezone.', 503);
  }
  return {
    available: true,
    fixed: true,
    startAt: new Date(startAt).toISOString(),
    durationMinutes,
    timezone
  };
}

export function createApiServer() {
  return createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins().has(origin)) {
      sendJson(response, 403, { available: false, message: 'This website is not allowed to use the API.' });
      return;
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Accept',
        'Access-Control-Max-Age': '86400',
        ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {})
      });
      response.end();
      return;
    }
    if (request.method !== 'GET') {
      sendJson(response, 405, { message: 'Method not allowed.' }, origin);
      return;
    }

    const route = new URL(request.url || '/', 'http://localhost').pathname;
    try {
      if (route === '/api/health') {
        sendJson(response, 200, {
          ok: true,
          twitchConfigured: Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET)
        }, origin);
        return;
      }
      if (route === '/api/stream') {
        sendJson(response, 200, await streamStatus(), origin);
        return;
      }
      if (route === '/api/clips') {
        const query = new URL(request.url || '/', 'http://localhost').searchParams;
        const firstValue = query.get('first') || '24';
        const after = query.get('after') || '';
        const first = Number(firstValue);
        if (!/^\d+$/.test(firstValue) || !Number.isInteger(first) || first < 1 || first > 100) {
          sendJson(response, 400, { available: false, message: 'The clips page size must be between 1 and 100.' }, origin);
          return;
        }
        if (after && (after.length > 1000 || /[\u0000-\u001f\u007f]/.test(after))) {
          sendJson(response, 400, { available: false, message: 'The Twitch clips cursor is invalid.' }, origin);
          return;
        }
        sendJson(response, 200, await recentClips(first, after), origin);
        return;
      }
      if (route === '/api/schedule') {
        sendJson(response, 200, schedule(), origin);
        return;
      }
      sendJson(response, 404, { message: 'Not found.' }, origin);
    } catch (error) {
      const status = error instanceof TwitchApiError ? error.status : 502;
      console.error(`API request failed for ${route}:`, error);
      sendJson(response, status, {
        available: false,
        message: status === 503 ? error.message : 'The Twitch service is temporarily unavailable.'
      }, origin);
    }
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const server = createApiServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`helbbizTTV API listening on port ${port}`);
  });
}
