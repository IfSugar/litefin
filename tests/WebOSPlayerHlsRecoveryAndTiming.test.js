import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player Hls.js Recovery, Manifest Polling and Timeupdate Test Suite
 * ============================================================================
 *   - Hls.js fatal errors: bounded retries, then a reported failure (A5)
 *   - a media element error during Hls.js playback gets the same recovery (A5)
 * ============================================================================
 */

function createEventTarget(base) {
    const listeners = {};
    return Object.assign(base, {
        addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
        removeEventListener: (type, fn) => (listeners[type] = (listeners[type] || []).filter((f) => f !== fn)),
        fire: (type) => (listeners[type] || []).slice().forEach((fn) => fn({ target: base }))
    });
}

function createVideo() {
    return createEventTarget({
        children: [],
        style: {},
        audioTracks: [],
        textTracks: [],
        readyState: 4,
        currentTime: 0,
        duration: 3600,
        paused: false,
        seekable: { length: 1 },
        buffered: { length: 0 },
        error: null,
        src: '',
        get firstChild() {
            return this.children[0] || null;
        },
        setAttribute() {},
        removeAttribute() {},
        appendChild(child) {
            this.children.push(child);
        },
        removeChild(child) {
            this.children = this.children.filter((c) => c !== child);
        },
        load() {},
        pause() {},
        play: () => Promise.resolve(),
        canPlayType: () => ''
    });
}

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = createEventTarget({
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    body: { appendChild: () => {} },
    createElement: (tag) =>
        tag === 'video'
            ? createVideo()
            : createEventTarget({ classList: { add() {}, remove() {} }, style: {}, querySelectorAll: () => [], appendChild() {} })
});

let manifestReady = true;
let manifestFetches = 0;
globalThis.fetch = async () => {
    manifestFetches++;
    return { ok: true, text: async () => (manifestReady ? '#EXTM3U\n' : '') };
};

const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');
const { default: Hls } = await import('hls.js');

function createPlayer() {
    const events = [];
    const player = new WebOSPlayer({
        container: { clientWidth: 1920, clientHeight: 1080, style: {}, appendChild() {} },
        onEvent: (e) => events.push(e)
    });
    return { player, events };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createFakeHls() {
    const calls = [];
    return {
        calls,
        startLoad: () => calls.push('startLoad'),
        recoverMediaError: () => calls.push('recoverMediaError'),
        swapAudioCodec: () => calls.push('swapAudioCodec')
    };
}

const fatal = (type, details, extra = {}) => ({ fatal: true, type, details, ...extra });

// ----------------------------------------------------------------------------
// A5 — Hls.js recovery
// ----------------------------------------------------------------------------

test('WebOSPlayer: fatal Hls.js network errors are retried with backoff, then reported', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    const hls = createFakeHls();
    player._hlsPlayer = hls;
    const failures = [];
    const { onError } = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    const networkError = fatal(Hls.ErrorTypes.NETWORK_ERROR, 'fragLoadError');

    for (const delay of [1000, 2000, 4000]) {
        onError('hlsError', networkError);
        const before = hls.calls.length;
        t.mock.timers.tick(delay - 1);
        assert.strictEqual(hls.calls.length, before, `startLoad() before ${delay} ms`);
        t.mock.timers.tick(1);
        assert.strictEqual(hls.calls.length, before + 1, `no startLoad() after ${delay} ms`);
    }
    assert.deepStrictEqual(hls.calls, ['startLoad', 'startLoad', 'startLoad']);

    onError('hlsError', networkError);
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0].isNetworkError, true);
});

test('WebOSPlayer: an HTTP error response is not retried, and a loaded fragment resets the retry budget', () => {
    const { player } = createPlayer();
    const hls = createFakeHls();
    const failures = [];
    const handler = player._createHlsErrorHandler(hls, (err) => failures.push(err));

    handler.onError('hlsError', fatal(Hls.ErrorTypes.NETWORK_ERROR, 'manifestLoadError', { response: { code: 404 } }));
    assert.strictEqual(failures.length, 1);
    assert.match(failures[0].message, /HTTP 404/);

    const other = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    for (let i = 0; i < 3; i++) other.onError('hlsError', fatal(Hls.ErrorTypes.NETWORK_ERROR, 'fragLoadError'));
    other.onFragLoaded();
    other.onError('hlsError', fatal(Hls.ErrorTypes.NETWORK_ERROR, 'fragLoadError'));
    assert.strictEqual(failures.length, 1, 'retry budget was not reset by a loaded fragment');
});

test('WebOSPlayer: fatal Hls.js media errors get a decoder reset, then a codec swap, then are reported', (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    const { player } = createPlayer();
    const hls = createFakeHls();
    const failures = [];
    const { onError } = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    const mediaError = fatal(Hls.ErrorTypes.MEDIA_ERROR, 'bufferAppendError');

    t.mock.timers.tick(10000);
    onError('hlsError', mediaError);
    onError('hlsError', mediaError);
    assert.deepStrictEqual(hls.calls, ['recoverMediaError', 'swapAudioCodec', 'recoverMediaError']);
    onError('hlsError', mediaError);
    assert.strictEqual(failures.length, 1);

    // Spaced-out errors keep recovering
    t.mock.timers.tick(5000);
    onError('hlsError', mediaError);
    assert.strictEqual(hls.calls.at(-1), 'recoverMediaError');
    assert.strictEqual(failures.length, 1);
});

test('WebOSPlayer: non-fatal Hls.js errors trigger no recovery', () => {
    const { player } = createPlayer();
    const hls = createFakeHls();
    const failures = [];
    const { onError } = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    onError('hlsError', { fatal: false, type: Hls.ErrorTypes.NETWORK_ERROR, details: 'fragLoadError' });
    onError('hlsError', { fatal: false, type: Hls.ErrorTypes.MEDIA_ERROR, details: 'bufferStalledError' });
    assert.deepStrictEqual(hls.calls, []);
    assert.deepStrictEqual(failures, []);
});

test('WebOSPlayer: a media element error during Hls.js playback gets the same bounded recovery', (t) => {
    // Hls.js only logs <video> errors, so the player must recover them itself
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    t.mock.timers.tick(10000);
    const { player, events } = createPlayer();
    const video = player._ensureVideoElement();
    const hls = createFakeHls();
    const failures = [];
    player._hlsPlayer = hls;
    const handling = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    player._hlsElementErrorHandler = { hls, onError: handling.onError };
    video.src = 'blob:hls';
    video.error = { code: 3, message: 'PIPELINE_ERROR_DECODE' };

    video.fire('error');
    assert.deepStrictEqual(hls.calls, ['recoverMediaError'], 'decode error not recovered in place');
    video.fire('error');
    assert.deepStrictEqual(hls.calls, ['recoverMediaError', 'swapAudioCodec', 'recoverMediaError']);
    video.fire('error');
    assert.strictEqual(failures.length, 1, 'a decoder that keeps failing must be reported');
    assert.strictEqual(events.filter((e) => e.type === 'error').length, 0, 'reported twice');
});
