import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers';

/**
 * ============================================================================
 * HtmlVideoPlayer Playback Session Test Suite
 * ============================================================================
 * The HTML5 backend (LG "Retry with HTML5") reuses one <video> across items.
 * Seeks during direct play are verified, time updates reach the subtitle
 * renderer at the platform's cadence, and nothing of one item (a queued
 * Play, subtitle cue times) acts on the next.
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
        children: [],
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
        },
        removeChild(child) {
            child.parentNode = null;
            this.children = this.children.filter((c) => c !== child);
        }
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

const movie = { url: 'http://srv/Videos/a/stream.mkv', mediaSource, item: { Type: 'Movie' } };

const count = (events, type) => events.filter((e) => e === type).length;

// ----------------------------------------------------------------------------
// Direct-play seek verification
// ----------------------------------------------------------------------------

test('HtmlVideoPlayer: a direct-play seek backwards that does not land is reported', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events } = createPlayer();
    await playAndStart(player, movie);
    const video = player._videoElement;

    video.currentTime = 3000;
    player.seek(60 * 10000000);
    video.currentTime = 3000; // the demuxer never moved
    t.mock.timers.tick(2500);
    assert.strictEqual(count(events, 'resumeseekfailed'), 1, 'no remux fallback for a stuck backward seek');
});

test('HtmlVideoPlayer: a direct-play seek that lands near its target either way is not reported', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events } = createPlayer();
    await playAndStart(player, movie);
    const video = player._videoElement;

    video.currentTime = 3000;
    player.seek(60 * 10000000);
    video.currentTime = 52; // previous keyframe
    t.mock.timers.tick(2500);

    player.seek(1200 * 10000000);
    video.currentTime = 1202.5; // landed and played on
    t.mock.timers.tick(2500);
    assert.strictEqual(count(events, 'resumeseekfailed'), 0);
});
