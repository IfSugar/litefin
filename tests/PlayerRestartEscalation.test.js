import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * JellyfinPlayer Restart & Escalation Test Suite
 * ============================================================================
 * Restart flows (quality change, track switch, resume fallback, error
 * escalation) share the _isRestarting flag and the DirectPlay → Remux →
 * Transcode ladder. The JellyfinPlayer methods under test are taken from the
 * source and run on a stub player (the module itself needs a full DOM).
 * ============================================================================
 */

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

const playerEventSource = source.slice(
    source.indexOf('export const PlayerEvent = {'),
    source.indexOf('};', source.indexOf('export const PlayerEvent = {')) + 2
).replace('export const', 'const');

const quietLog = { info() {}, debug() {}, warn() {}, error() {} };

/**
 * A stub JellyfinPlayer with the given real methods.
 * play() / stop() are recorded unless 'async play(options) {' is loaded.
 */
function createPlayer(signatures, { settings = {}, globals = {} } = {}) {
    const context = vm.createContext({
        // Restart flows wait 300–500 ms between stop() and play(); skip that here
        setTimeout: (fn) => setTimeout(fn, 0),
        clearTimeout,
        Promise,
        log: quietLog,
        PlayerSettings: { get: (key) => settings[key] },
        ...globals
    });
    const methods = vm.runInContext(
        `${playerEventSource}\n({ PlayerEvent, methods: {\n${signatures.map(extractMethod).join(',\n')}\n} })`,
        context
    );

    const player = Object.assign(Object.create(methods.methods), {
        PlayerEvent: methods.PlayerEvent,
        events: [],
        playCalls: [],
        _isRestarting: false,
        _audioRestartInProgress: false,
        _isSeeking: false,
        _pendingTranscodeSeekTicks: null,
        _pendingStartPositionTicks: null,
        _remuxWatchdogActive: false,
        _directPlayEscalated: false,
        _backendType: 'webos',
        _backend: { stop: async () => {} },
        _currentPlayMethod: 'DirectPlay',
        _playbackMode: 'auto',
        _currentPlayOptions: { itemId: 'item1', startPositionTicks: 0 },
        _lastPlayOptions: null,
        armedWatchdogs: [],
        emit(type, data) {
            this.events.push(type);
        },
        async stop() {},
        getCurrentPositionTicks: () => 6000000000,
        _armRemuxStuckWatchdog(ticks) {
            this.armedWatchdogs.push(ticks);
        },
        _clearRemuxStuckWatchdog() {}
    });
    if (!signatures.includes('async play(options) {')) {
        player.play = async function (options) {
            this.playCalls.push(options);
        };
    }
    return player;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// ----------------------------------------------------------------------------
// C1 — quality change
// ----------------------------------------------------------------------------

test('JellyfinPlayer: a quality change does not leave the player in the restarting state', async () => {
    const player = createPlayer(['async setMaxBitrate(bitrate) {', '_handleBackendEvent(event) {']);
    player._currentItem = { Id: 'item1' };

    await player.setMaxBitrate(8000000);
    assert.strictEqual(player._isRestarting, false);
    assert.strictEqual(player.playCalls.length, 1);

    // A later direct-play error still escalates to a transcode
    player._handleBackendEvent({ type: 'error', data: { code: 3, message: 'MEDIA_ERR_DECODE' } });
    await settle();
    assert.strictEqual(player.playCalls.length, 2, 'error after a quality change was not escalated');
    assert.strictEqual(player.playCalls[1].playbackMode, 'transcode');
});

test('JellyfinPlayer: a failed quality change also clears the restarting state', async () => {
    const player = createPlayer(['async setMaxBitrate(bitrate) {']);
    player._currentItem = { Id: 'item1' };
    player.play = async () => {
        throw new Error('PlaybackInfo failed: 500');
    };

    await player.setMaxBitrate(8000000);
    assert.strictEqual(player._isRestarting, false);
});

// ----------------------------------------------------------------------------
// C2 — resume failure ladder
// ----------------------------------------------------------------------------

function resumeFailed(player) {
    player._handleBackendEvent({ type: 'resumeseekfailed', data: { targetPositionTicks: 6000000000 } });
}

test('JellyfinPlayer: a failed direct-play resume restarts as a remux and arms the watchdog', async () => {
    const player = createPlayer(['_handleBackendEvent(event) {']);
    resumeFailed(player);
    await settle();
    assert.strictEqual(player.playCalls[0].playbackMode, 'remux');
    assert.deepStrictEqual(player.armedWatchdogs, [6000000000]);
});

test('JellyfinPlayer: a failed remux resume escalates to a transcode', async () => {
    const player = createPlayer(['_handleBackendEvent(event) {']);
    player._currentPlayMethod = 'Remux';
    resumeFailed(player);
    await settle();
    assert.strictEqual(player.playCalls[0].playbackMode, 'transcode');
    assert.deepStrictEqual(player.armedWatchdogs, []);
});

test('JellyfinPlayer: the one-retry limit of a transcoded resume does not leak into later restarts', async () => {
    const player = createPlayer(['_handleBackendEvent(event) {']);
    player._currentPlayMethod = 'Transcode';
    resumeFailed(player);
    await settle();
    assert.strictEqual(player.playCalls.length, 1);

    // A later restart of the item (e.g. a quality change) builds new options from the retried ones
    player._currentPlayOptions = { ...player.playCalls[0], startPositionTicks: 9000000000 };
    resumeFailed(player);
    await settle();
    assert.strictEqual(player.playCalls.length, 2, 'the retry limit blocked a later restart for good');
});

test('JellyfinPlayer: a failed transcode resume never restarts as a remux, and retries only once', async () => {
    const player = createPlayer(['_handleBackendEvent(event) {']);
    player._currentPlayMethod = 'Transcode';
    resumeFailed(player);
    await settle();
    assert.strictEqual(player.playCalls.length, 1);
    assert.strictEqual(player.playCalls[0].playbackMode, 'transcode');
    assert.deepStrictEqual(player.armedWatchdogs, []);

    // The retried transcode fails to land as well: keep playing, no loop
    player._currentPlayOptions = player.playCalls[0];
    resumeFailed(player);
    await settle();
    assert.strictEqual(player.playCalls.length, 1);
});
