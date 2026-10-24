import assert from 'node:assert/strict';
import test from 'node:test';

// Setup mock window and localStorage for headless Node environment
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (k) => storageMap.get(k) || null,
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k),
    clear: () => storageMap.clear()
};
globalThis.window = globalThis;

// Dynamically import CustomHeaders after global mocks are installed
const { customHeaders, HEADER_PRESETS } = await import('../src/utils/CustomHeaders.js');

/**
 * ============================================================================
 * Custom HTTP Headers Test Suite
 * ============================================================================
 * Verifies that:
 *   1. Presets (Cloudflare Zero Trust, Pangolin) are correctly defined.
 *   2. RFC 7230 character validation and control-character filtering work.
 *   3. Reserved Jellyfin/Emby authentication headers are blocked.
 *   4. URL origin/subpath isolation prevents leaking proxy credentials to 3rd parties.
 * ============================================================================
 */

test('CustomHeaders: presets structure and integrity', () => {
    assert.strictEqual(Array.isArray(HEADER_PRESETS), true);
    assert.strictEqual(HEADER_PRESETS.length >= 2, true);

    const cf = HEADER_PRESETS.find((p) => p.id === 'cloudflare');
    assert.ok(cf);
    assert.strictEqual(cf.headers.some((h) => h.key === 'CF-Access-Client-Id'), true);
    assert.strictEqual(cf.headers.some((h) => h.key === 'CF-Access-Client-Secret'), true);

    const pangolin = HEADER_PRESETS.find((p) => p.id === 'pangolin');
    assert.ok(pangolin);
    assert.strictEqual(pangolin.headers.some((h) => h.key === 'P-Access-Token-Id'), true);
    assert.strictEqual(pangolin.headers.some((h) => h.key === 'P-Access-Token'), true);
});

test('CustomHeaders: normalizeHeaders enforces RFC 7230 and drops disabled/empty rows', () => {
    const raw = [
        { key: 'CF-Access-Client-Id', value: 'my-client-id-123', enabled: true },
        { key: 'CF-Access-Client-Secret', value: 'my-secret-456', enabled: true },
        { key: 'X-Disabled-Header', value: 'skip-me', enabled: false },
        { key: '', value: 'empty-key', enabled: true },
        { key: 'Invalid Header Name!', value: 'bad', enabled: true },
        { key: 'Invalid:Colon', value: 'bad', enabled: true },
        { key: 'Clean-Header', value: 'valid-val', enabled: true }
    ];

    const normalized = customHeaders.normalizeHeaders(raw);

    assert.strictEqual(normalized['CF-Access-Client-Id'], 'my-client-id-123');
    assert.strictEqual(normalized['CF-Access-Client-Secret'], 'my-secret-456');
    assert.strictEqual(normalized['Clean-Header'], 'valid-val');
    assert.strictEqual(normalized['X-Disabled-Header'], undefined);
    assert.strictEqual(normalized[''], undefined);
    assert.strictEqual(normalized['Invalid Header Name!'], undefined);
    assert.strictEqual(normalized['Invalid:Colon'], undefined);
});

test('CustomHeaders: normalizeHeaders drops reserved auth headers and blocks control characters', () => {
    const raw = [
        { key: 'Authorization', value: 'Bearer token', enabled: true },
        { key: 'authorization', value: 'Bearer token', enabled: true },
        { key: 'X-Emby-Token', value: 'emby-secret', enabled: true },
        { key: 'x-emby-authorization', value: 'emby-auth', enabled: true },
        { key: 'X-Injection-Attempt', value: "bad\r\nInjected-Header: evil", enabled: true },
        { key: 'Valid-Key', value: 'CleanValue', enabled: true }
    ];

    const normalized = customHeaders.normalizeHeaders(raw);

    assert.strictEqual(normalized['Authorization'], undefined);
    assert.strictEqual(normalized['authorization'], undefined);
    assert.strictEqual(normalized['X-Emby-Token'], undefined);
    assert.strictEqual(normalized['x-emby-authorization'], undefined);
    assert.strictEqual(normalized['X-Injection-Attempt'], undefined);
    assert.strictEqual(normalized['Valid-Key'], 'CleanValue');
});

test('CustomHeaders: deduplicates header names case-insensitively', () => {
    const raw = [
        { key: 'X-Custom-Proxy', value: 'FirstValue', enabled: true },
        { key: 'x-custom-proxy', value: 'SecondValue', enabled: true }
    ];

    const normalized = customHeaders.normalizeHeaders(raw);
    assert.strictEqual(normalized['X-Custom-Proxy'], 'FirstValue');
    assert.strictEqual(Object.keys(normalized).length, 1);
});

test('CustomHeaders: isUrlForServer prevents leaking proxy credentials to 3rd-party hosts', () => {
    const server = 'https://jellyfin.example.com/subpath';

    // Same server origin and path matching
    assert.strictEqual(customHeaders.isUrlForServer('https://jellyfin.example.com/subpath/Items', server), true);
    assert.strictEqual(customHeaders.isUrlForServer('https://jellyfin.example.com/subpath/System/Info/Public', server), true);

    // Outside subpath on same host
    assert.strictEqual(customHeaders.isUrlForServer('https://jellyfin.example.com/otherapp/api', server), false);

    // External third-party domains (TMDB, OpenSubtitles, YouTube) must be rejected
    assert.strictEqual(customHeaders.isUrlForServer('https://api.themoviedb.org/3/movie/550', server), false);
    assert.strictEqual(customHeaders.isUrlForServer('https://image.tmdb.org/t/p/original/poster.jpg', server), false);
    assert.strictEqual(customHeaders.isUrlForServer('https://fanart.tv/fanart/movie/poster.jpg', server), false);
    assert.strictEqual(customHeaders.isUrlForServer('http://localhost:8123/trailer?url=test', server), false);

    // Standard root server
    const rootServer = 'https://jellyfin.local:8096';
    assert.strictEqual(customHeaders.isUrlForServer('https://jellyfin.local:8096/Items/123/Images/Primary', rootServer), true);
    assert.strictEqual(customHeaders.isUrlForServer('https://evil-spoof.com/jellyfin.local:8096/Items', rootServer), false);
});

test('CustomHeaders: getHeadersForUrl returns headers only when URL belongs to server', () => {
    const serverUrl = 'https://media.proxy.net';
    const testHeaders = [
        { key: 'CF-Access-Client-Id', value: 'id-abc', enabled: true },
        { key: 'CF-Access-Client-Secret', value: 'secret-xyz', enabled: true }
    ];

    customHeaders.setServerHeaders(serverUrl, testHeaders);

    // Matching request URL
    const match = customHeaders.getHeadersForUrl('https://media.proxy.net/System/Info', serverUrl);
    assert.strictEqual(match['CF-Access-Client-Id'], 'id-abc');
    assert.strictEqual(match['CF-Access-Client-Secret'], 'secret-xyz');

    // Non-matching third-party URL
    const noMatch = customHeaders.getHeadersForUrl('https://image.tmdb.org/poster.jpg', serverUrl);
    assert.deepStrictEqual(noMatch, {});
});

test('CustomHeaders: getServerHeaders supports protocol-agnostic lookup fallback', () => {
    const bareHost = 'jellyfin.myproxy.org';
    const testHeaders = [
        { key: 'CF-Access-Client-Id', value: 'token-999', enabled: true }
    ];

    customHeaders.setServerHeaders(bareHost, testHeaders);

    // Should resolve when queried with full https:// URL
    const retrievedWithHttps = customHeaders.getServerHeaders(`https://${bareHost}`);
    assert.strictEqual(retrievedWithHttps.length, 1);
    assert.strictEqual(retrievedWithHttps[0].key, 'CF-Access-Client-Id');
    assert.strictEqual(retrievedWithHttps[0].value, 'token-999');

    // And vice-versa: headers saved with full https:// URL can be queried with bare host
    const fullUrl = 'https://emby.myproxy.org';
    customHeaders.setServerHeaders(fullUrl, testHeaders);
    const retrievedWithBare = customHeaders.getServerHeaders('emby.myproxy.org');
    assert.strictEqual(retrievedWithBare.length, 1);
    assert.strictEqual(retrievedWithBare[0].key, 'CF-Access-Client-Id');
});
