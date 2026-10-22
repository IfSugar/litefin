import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * HtmlVideoPlayer Lifecycle Test Suite
 * ============================================================================
 * The HTML5 backend (used on LG for "Retry with HTML5") reuses one <video>
 * across items. Timers and one-shot listeners of a playback must end with
 * stop() / the next play(), or they act on the next item.
 * ============================================================================
 */

function createEventTarget(base) {
    const listeners = {};
    return Object.assign(base, {
        addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
        removeEventListener: (type, fn) => (listeners[type] = (listeners[type] || []).filter((f) => f !== fn)),
        listenerCount: (type) => (listeners[type] || []).length,
        fire: (type) => (listeners[type] || []).slice().forEach((fn) => fn({ target: base }))
    });
}

function createVideo() {
    return createEventTarget({
        style: {},
        children: [],
        parentNode: null,
        audioTracks: [],
        textTracks: [],
        readyState: 4,
        currentTime: 0,
        duration: 3600,
        muted: false,
        paused: true,
        seeking: false,
        error: null,
        src: '',
        playCalls: 0,
        firstChild: null,
        setAttribute() {},
        removeAttribute(name) {
            if (name === 'src') this.src = '';
        },
        load() {},
        pause() {
            this.paused = true;
        },
        play() {
            this.playCalls++;
            this.paused = false;
            return Promise.resolve();
        },
        canPlayType: () => ''
    });
}

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = createEventTarget({
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    body: { appendChild: () => {} },
    createElement: (tag) => (tag === 'video' ? createVideo() : { style: {}, canPlayType: () => '', appendChild() {} })
});
globalThis.fetch = async () => ({ ok: true, text: async () => '#EXTM3U\n' });

const { HtmlVideoPlayer } = await import('../src/player/core/HtmlVideoPlayer.js');

const mediaSource = {
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'h264' },
        { Index: 1, Type: 'Audio', Codec: 'aac', IsDefault: true }
    ]
};

function createPlayer() {
    const events = [];
    const container = {
        clientWidth: 1920,
        clientHeight: 1080,
        style: {},
        appendChild(child) {
            child.parentNode = this;
        },
        removeChild() {}
    };
    const player = new HtmlVideoPlayer({ container, onEvent: (e) => events.push(e.type) });
    return { player, events };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function playAndStart(player, options) {
    const playing = player.play(options);
    await flush();
    await flush();
    player._videoElement.fire('canplay');
    await playing;
}

test('HtmlVideoPlayer: a direct-play seek check does not fire after stop()', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events } = createPlayer();
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mkv', mediaSource, item: { Type: 'Movie' } });

    player.seek(600 * 10000000); // user seeks to 10:00
    await player.stop(); // ...and backs out / the next episode starts
    player._videoElement.currentTime = 0;

    t.mock.timers.tick(3000);
    assert.ok(!events.includes('resumeseekfailed'), 'would restart the next item at the old position');
});

test('HtmlVideoPlayer: HLS seeks are not verified like progressive direct play', async (t) => {
    const { player, events } = createPlayer();
    await playAndStart(player, { url: 'http://srv/videos/a/master.m3u8', isHls: true, mediaSource, item: { Type: 'Movie' } });
    assert.strictEqual(player._isHls, true);

    t.mock.timers.enable({ apis: ['setTimeout'] });
    player.seek(600 * 10000000);
    player._videoElement.currentTime = 0; // segment still loading
    t.mock.timers.tick(3000);
    assert.ok(!events.includes('resumeseekfailed'));
});

test('HtmlVideoPlayer: a load abandoned by stop() rejects and never acts on the next item', async () => {
    const { player } = createPlayer();
    const playA = player.play({ url: 'http://srv/Videos/a/stream.mkv', mediaSource, playerStartPositionTicks: 6000000000 });
    await flush();
    await player.stop();
    await assert.rejects(playA, (err) => err.name === 'AbortError' && err.superseded === true);

    await playAndStart(player, { url: 'http://srv/Videos/b/stream.mkv', mediaSource });
    const video = player._videoElement;
    assert.strictEqual(video.playCalls, 1);
    assert.strictEqual(video.currentTime, 0, 'item A\'s resume seek ran on item B');
    assert.strictEqual(video.listenerCount('canplay'), 0);
});

test('HtmlVideoPlayer: the resume follow-up check is cleared by stop()', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events } = createPlayer();
    const video = player._ensureVideoElement();
    player._currentPlayOptions = { mediaSource };

    player._applyPlaybackResume(video, { playerStartPositionTicks: 6000000000 });
    await player.stop();
    video.currentTime = 0;
    t.mock.timers.tick(3000);

    assert.ok(!events.includes('resumeseekfailed'));
});
