/* eslint-env node */
import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * Player Controller Follow-up Test Suite
 * ============================================================================
 * Follow-ups to the player controller (JellyfinPlayer, MediaHelper):
 *   - HLS manifest polling stops at a client error (4xx)
 * ============================================================================
 */

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };

const { MediaHelper } = await import('../src/player/core/MediaHelper.js');

const realFetch = globalThis.fetch;
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Advance mocked time in steps, letting promise chains run in between. */
async function advance(t, ms, step = 250) {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
        t.mock.timers.tick(step);
        await flush();
    }
}

// ----------------------------------------------------------------------------
// HLS manifest polling
// ----------------------------------------------------------------------------

/** A fetch() that answers every request with the given HTTP status. */
function answeringFetch(status) {
    const requests = [];
    const fetch = async (url) => {
        requests.push(url);
        return { ok: status >= 200 && status < 300, status, text: async () => (status === 200 ? '#EXTM3U\n' : '') };
    };
    return { fetch, requests };
}

test('MediaHelper.pollHlsManifest: a client error ends polling at once instead of after 15 s', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    for (const status of [400, 401, 403, 404]) {
        const server = answeringFetch(status);
        globalThis.fetch = server.fetch;
        try {
            let finished = false;
            MediaHelper.pollHlsManifest('http://srv/videos/x/master.m3u8').then(() => (finished = true));
            await flush();
            await flush();
            assert.ok(finished, `HTTP ${status}: still polling`);
            assert.strictEqual(server.requests.length, 1, `HTTP ${status}: asked again`);
        } finally {
            globalThis.fetch = realFetch;
        }
    }
});

test('MediaHelper.pollHlsManifest: server errors and "try again later" answers are retried within the budget', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    for (const status of [503, 429]) {
        const server = answeringFetch(status);
        globalThis.fetch = server.fetch;
        try {
            let finished = false;
            MediaHelper.pollHlsManifest('http://srv/videos/x/master.m3u8').then(() => (finished = true));
            await advance(t, 2000);
            assert.ok(!finished, `HTTP ${status}: polling gave up early`);
            assert.ok(server.requests.length >= 3, `HTTP ${status}: ${server.requests.length} requests`);

            await advance(t, 13500);
            assert.ok(finished, `HTTP ${status}: polling went past its 15 s budget`);
        } finally {
            globalThis.fetch = realFetch;
        }
    }
});

test('MediaHelper.pollHlsManifest: a ready manifest still ends polling (guard)', async () => {
    const server = answeringFetch(200);
    globalThis.fetch = server.fetch;
    try {
        await MediaHelper.pollHlsManifest('http://srv/videos/x/master.m3u8');
        assert.strictEqual(server.requests.length, 1);
    } finally {
        globalThis.fetch = realFetch;
    }
});
