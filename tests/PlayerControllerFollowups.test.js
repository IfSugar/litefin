/* eslint-env node */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * Player Controller Follow-up Test Suite
 * ============================================================================
 * Follow-ups to the player controller (JellyfinPlayer, MediaHelper):
 *   - HLS manifest polling stops at a client error (4xx)
 *   - the global bitrate limit does not force a transcode of the first item
 * The JellyfinPlayer methods under test are taken from the source and run on
 * a stub player (the module itself needs a full DOM).
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
// JellyfinPlayer harness
// ----------------------------------------------------------------------------

const source = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
);

/** Source of one class method, from its signature to the closing brace at method indentation. */
function extractMethod(signature) {
    const start = source.indexOf(`\n    ${signature}`);
    assert.ok(start !== -1, `method not found: ${signature}`);
    const end = source.indexOf('\n    }\n', start);
    return source.slice(start + 1, end + 6);
}

const playerEventSource = source
    .slice(
        source.indexOf('export const PlayerEvent = {'),
        source.indexOf('};', source.indexOf('export const PlayerEvent = {')) + 2
    )
    .replace('export const', 'const');

const quietLog = { info() {}, debug() {}, warn() {}, error() {} };

/** Globals the extracted methods use, with the real MediaHelper where it matters. */
function playerGlobals(settings, globals) {
    return {
        // Through the globals, so mocked timers apply
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id),
        Promise,
        Object,
        Number,
        Date,
        JSON,
        Math,
        log: quietLog,
        PlayerSettings: { get: (key) => settings[key] },
        TizenAVPlayer: class {},
        HtmlVideoPlayer: class {},
        platformInfo: {},
        webCodecsProbe: {},
        buildJellyfinProfile: () => ({ Name: 'stub', DirectPlayProfiles: [{}] }),
        resolveBestAudioStream: () => null,
        isAudioTrackNativelyPlayable: () => true,
        doesAudioTrackRequireDirectStream: () => false,
        rememberContainerWithoutAudioTracks: () => {},
        resolveSubtitleStream: () => -1,
        isTrueHdSupported: () => false,
        isDtsSupported: () => false,
        prewarmManager: { consumePlaybackInfo: () => null },
        api: { isEmby: () => false, getAuthHeader: () => 'MediaBrowser Token="t"', getItem: async () => ({}) },
        MediaHelper: {
            getPlayMethod: () => 'DirectPlay',
            buildStreamUrl: ({ itemId, startPositionTicks }) => ({
                url: `http://srv/${itemId}`,
                transcodingOffsetTicks: 0,
                playerStartPositionTicks: startPositionTicks
            }),
            fetchWithTimeout: MediaHelper.fetchWithTimeout
        },
        PLAYBACK_INFO_TIMEOUT_MS: 30000,
        ...globals
    };
}

/**
 * A backend whose play() stays pending until the test settles it. stop()
 * rejects a pending load as superseded, like the webOS and HTML5 backends.
 */
function createBackend() {
    const backend = {
        loads: [],
        pending: null,
        speeds: [],
        play(options) {
            return new Promise((resolve, reject) => {
                const load = { options, resolve, reject };
                backend.loads.push(load);
                backend.pending = load;
            });
        },
        async stop() {
            const load = backend.pending;
            backend.pending = null;
            if (load) {
                const error = new Error('Playback load was superseded by a newer request');
                error.name = 'AbortError';
                error.superseded = true;
                load.reject(error);
            }
        },
        setSpeed(speed) {
            backend.speeds.push(speed);
        },
        getCurrentTime: () => 0,
        supportsNativeAudioTracks: () => true
    };
    return backend;
}

/** Real methods every stub player gets (play() and what it calls). */
const PLAYER_METHODS = [
    'async play(options) {',
    'async stop() {',
    '_handleBackendEvent(event) {',
    'getPlaybackMode() {',
    'getMaxBitrate() {',
    '_abandonSupersededPlay(stage) {',
    'async _playAfterRestartPause(options, pauseMs) {',
    '_clearResumeAdvanceWait() {',
    '_isAwaitingResumeAdvance(time) {',
    '_finishResumeWait(message) {',
    'getCurrentPositionTicks() {'
];

/**
 * A stub JellyfinPlayer running the real methods above plus `methods`.
 * PlaybackInfo is answered at once (`player._getPlaybackInfo` can be
 * replaced, or deleted to use the real one from the prototype).
 */
function createPlayer({ methods = [], settings = {}, globals = {} } = {}) {
    const profiles = [];
    const context = vm.createContext(
        playerGlobals(settings, {
            buildJellyfinProfile: (options) => {
                profiles.push(options);
                return { Name: 'stub', DirectPlayProfiles: [{}] };
            },
            ...globals
        })
    );
    const loaded = vm.runInContext(
        `${playerEventSource}\n({ PlayerEvent, methods: {\n${PLAYER_METHODS.concat(methods).map(extractMethod).join(',\n')}\n} })`,
        context
    );
    const backend = createBackend();
    return Object.assign(Object.create(loaded.methods), {
        PlayerEvent: loaded.PlayerEvent,
        backend,
        profiles,
        events: [],
        infoRequests: [],
        armedWatchdogs: [],
        serverUrl: 'http://srv',
        authToken: 't',
        _playRequestId: 0,
        _isRestarting: false,
        _audioRestartInProgress: false,
        _directPlayEscalated: false,
        _isSeeking: false,
        _seekTargetTicks: null,
        _pendingStartPositionTicks: null,
        _resumeLastTime: null,
        _resumeAdvanceTimer: null,
        _transcodingOffsetTicks: 0,
        _remuxWatchdogActive: false,
        _manualBitrate: null,
        _backendType: 'webos',
        _backend: backend,
        _subtitleManager: { setMediaContext() {}, tick() {}, play() {}, pause() {}, resetActiveCues() {} },
        _currentPlayMethod: null,
        _playbackMode: 'auto',
        _initialPlaybackMode: 'auto',
        _audioRemuxFrom: null,
        _currentItem: null,
        _currentMediaSource: null,
        _currentPlayOptions: null,
        _lastPlayOptions: null,
        _isPlaying: false,
        _currentSecondarySubtitleStreamIndex: -1,
        emit(type, data) {
            this.events.push({ type, data });
        },
        async _getPlaybackInfo(options) {
            this.infoRequests.push(options);
            return {
                PlaySessionId: `session-${options.itemId}-${this.infoRequests.length}`,
                MediaSources: [
                    {
                        Id: options.itemId,
                        Container: 'mkv',
                        RunTimeTicks: 72000000000,
                        MediaStreams: [],
                        SupportsDirectPlay: true
                    }
                ]
            };
        },
        _resolveForcedRemuxPlayMethod: (mediaSource, playMethod) => playMethod,
        isCurrentMediaHDR: () => false,
        _getBackendAudioTrackListIndex: () => 1,
        async setSubtitleStreamIndex() {},
        _armRemuxStuckWatchdog(ticks) {
            this.armedWatchdogs.push(ticks);
        },
        _clearRemuxStuckWatchdog() {}
    });
}

async function waitFor(condition, what = 'condition') {
    for (let i = 0; i < 200 && !condition(); i++) {
        await flush();
    }
    assert.ok(condition(), `timed out waiting for ${what}`);
}

/** Start play() and let the backend load succeed as soon as it is requested. */
async function playAndStart(player, options) {
    const count = player.backend.loads.length;
    const result = player.play(options);
    await waitFor(() => player.backend.loads.length > count, 'the backend load');
    player.backend.loads[count].resolve();
    return result;
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

// ----------------------------------------------------------------------------
// Global bitrate limit
// ----------------------------------------------------------------------------

/** A JellyfinPlayer built by the real constructor (backend and subtitles stubbed). */
function constructPlayer(settings) {
    const context = vm.createContext(
        playerGlobals(settings, {
            EventEmitter: class {},
            SubtitleManager: class {}
        })
    );
    const JellyfinPlayer = vm.runInContext(
        `(class extends EventEmitter {\n${extractMethod('constructor(options) {')}\n${extractMethod('getMaxBitrate() {')}\n_initBackend() {}\n})`,
        context
    );
    return new JellyfinPlayer({ container: {} });
}

/** A stub player whose real _getPlaybackInfo() records the PlaybackInfo request bodies. */
function createPlaybackInfoPlayer(settings) {
    const bodies = [];
    const player = createPlayer({
        methods: ['async _getPlaybackInfo(options, deviceProfile, manualBitrate = null) {'],
        settings,
        globals: {
            buildJellyfinProfile: ({ manualBitrate }) => ({
                Name: 'stub',
                // The webOS, Tizen and web profiles fall back to the global limit
                MaxStreamingBitrate: manualBitrate || settings.maxBitrateInternet || 120000000,
                DirectPlayProfiles: [{}]
            }),
            MediaHelper: {
                getPlayMethod: () => 'DirectPlay',
                buildStreamUrl: ({ itemId }) => ({
                    url: itemId,
                    transcodingOffsetTicks: 0,
                    playerStartPositionTicks: 0
                }),
                fetchWithTimeout: async (url, init) => {
                    bodies.push(JSON.parse(init.body));
                    return {
                        response: { ok: true },
                        body: {
                            PlaySessionId: 'p',
                            MediaSources: [{ Id: 'x', MediaStreams: [], SupportsDirectPlay: true }]
                        }
                    };
                }
            }
        }
    });
    delete player._getPlaybackInfo; // the real one from the prototype
    return { player, bodies };
}

test('JellyfinPlayer: the global bitrate limit is not a quality picked in the OSD', () => {
    const player = constructPlayer({ maxBitrateInternet: 20000000 });
    assert.strictEqual(player._manualBitrate, null);
    assert.strictEqual(player.getMaxBitrate(), 0, 'the Quality menu shows Auto');
});

test('JellyfinPlayer: with a global bitrate limit, the first item is not forced to a transcode', async () => {
    const settings = { maxBitrateInternet: 20000000 };
    const { player, bodies } = createPlaybackInfoPlayer(settings);
    player._manualBitrate = constructPlayer(settings)._manualBitrate;

    await playAndStart(player, { itemId: 'A', userId: 'user', mediaSourceId: 'x' });
    await player.stop(); // next episode
    await playAndStart(player, { itemId: 'B', userId: 'user', mediaSourceId: 'x' });

    for (const [i, body] of bodies.entries()) {
        assert.strictEqual(body.EnableDirectPlay, true, `item ${i + 1}: direct play disabled`);
        assert.strictEqual(body.AllowVideoStreamCopy, undefined, `item ${i + 1}: video copy forbidden`);
        assert.strictEqual(body.MaxStreamingBitrate, 20000000, `item ${i + 1}: the limit was not sent`);
    }
    assert.strictEqual(bodies.length, 2);
});

test('JellyfinPlayer: a quality picked in the OSD still forces a transcode (guard)', async () => {
    const { player, bodies } = createPlaybackInfoPlayer({ maxBitrateInternet: 20000000 });
    player._manualBitrate = 4000000;

    await playAndStart(player, { itemId: 'A', userId: 'user', mediaSourceId: 'x' });
    assert.strictEqual(bodies[0].EnableDirectPlay, false);
    assert.strictEqual(bodies[0].AllowVideoStreamCopy, false);
    assert.strictEqual(bodies[0].MaxStreamingBitrate, 4000000);
});
