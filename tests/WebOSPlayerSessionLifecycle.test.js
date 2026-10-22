import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player Session Lifecycle Test Suite
 * ============================================================================
 * The <video> element is reused across items, so every one-shot listener,
 * timer and pending load of a playback session must end with stop() or the
 * next play(). Covers:
 *   - audio normalization keeps working across queued items (A4)
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// Minimal DOM: <video>/<source> stand-ins that can fire events
// ----------------------------------------------------------------------------

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
    const video = createEventTarget({
        tagName: 'VIDEO',
        children: [],
        style: {},
        parentNode: null,
        audioTracks: [],
        textTracks: [],
        readyState: 4,
        currentTime: 0,
        duration: 3600,
        muted: false,
        paused: true,
        seeking: false,
        videoWidth: 1920,
        videoHeight: 1080,
        volume: 1,
        seekable: { length: 1 },
        buffered: { length: 0 },
        error: null,
        src: '',
        playCalls: 0,
        get firstChild() {
            return this.children[0] || null;
        },
        setAttribute() {},
        removeAttribute(name) {
            if (name === 'src') this.src = '';
        },
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
        },
        removeChild(child) {
            this.children = this.children.filter((c) => c !== child);
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
    return video;
}

const createdVideos = [];
const documentTarget = createEventTarget({});

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = Object.assign(documentTarget, {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    body: { appendChild: () => {} },
    createElement(tag) {
        if (tag === 'video') {
            const video = createVideo();
            createdVideos.push(video);
            return video;
        }
        if (tag === 'source') return createEventTarget({ tagName: 'SOURCE', src: '', type: '' });
        return {
            classList: { add() {}, remove() {}, toggle() {} },
            style: {},
            addEventListener() {},
            querySelectorAll: () => [],
            appendChild() {},
            canPlayType: () => '',
            innerHTML: ''
        };
    }
});
globalThis.fetch = async () => ({ ok: true, text: async () => '#EXTM3U\n' });

const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');

const mediaSource = {
    Container: 'mkv',
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'h264' },
        { Index: 1, Type: 'Audio', Codec: 'aac', Language: 'eng', Channels: 2, IsDefault: true }
    ]
};

function createPlayer() {
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
    const events = [];
    const player = new WebOSPlayer({ container, onEvent: (e) => events.push(e.type) });
    return { player, events, container };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** play() and let the load reach 'canplay' */
async function playAndStart(player, options) {
    const playing = player.play(options);
    await flush();
    player._videoElement.fire('canplay');
    await playing;
}

// ----------------------------------------------------------------------------
// A4 — audio normalization across items
// ----------------------------------------------------------------------------

class StrictAudioContext {
    static instances = [];
    constructor() {
        StrictAudioContext.instances.push(this);
        this.state = 'running';
        this.closed = false;
        this.destination = {};
    }
    createMediaElementSource(element) {
        if (element.webAudioSource) {
            throw new Error('InvalidStateError: element already connected to a MediaElementSourceNode');
        }
        element.webAudioSource = true;
        this.usedForMedia = true;
        return { connect() {}, disconnect() {} };
    }
    createGain() {
        return { gain: { value: 1 }, connect() {}, disconnect() {} };
    }
    close() {
        this.closed = true;
        return Promise.resolve();
    }
    suspend() {
        this.state = 'suspended';
        return Promise.resolve();
    }
    resume() {
        this.state = 'running';
        return Promise.resolve();
    }
}

// Contexts of the normalization graph (the codec capability probe creates and closes its own)
const mediaContexts = () => StrictAudioContext.instances.filter((c) => c.usedForMedia);

const track = (gainDb) => ({
    url: 'http://srv/Audio/1/stream.mp3',
    item: { MediaType: 'Audio', NormalizationGain: gainDb },
    mediaSource: {}
});
const movie = { url: 'http://srv/Videos/m/stream.mkv', item: { Type: 'Movie', MediaType: 'Video' }, mediaSource };

test('WebOSPlayer: normalization works for every queued track and the next movie keeps its audio path', async () => {
    window.AudioContext = StrictAudioContext;
    StrictAudioContext.instances = [];
    const { player, container } = createPlayer();

    await playAndStart(player, track(-6));
    const firstElement = player._videoElement;
    assert.ok(Math.abs(player._audioGraph.gain.gain.value - 0.501) < 0.001);
    await player.stop();

    // The captured element is released with its graph; the context is kept
    assert.ok(!container.children.includes(firstElement));
    assert.strictEqual(mediaContexts()[0].closed, false);

    await playAndStart(player, track(-12));
    assert.ok(Math.abs(player._audioGraph.gain.gain.value - 0.251) < 0.001);
    assert.notStrictEqual(player._videoElement, firstElement);
    await player.stop();

    await playAndStart(player, track(-3));
    await player.stop();

    // One context for the whole queue: Chromium 38 cannot close() contexts and
    // Chromium caps how many can exist
    assert.strictEqual(mediaContexts().length, 1, 'an AudioContext per track runs out on old TVs');
    assert.strictEqual(mediaContexts()[0].closed, false);

    await playAndStart(player, movie);
    assert.strictEqual(player._audioGraph, null);
    assert.ok(!player._videoElement.webAudioSource, 'movie element is routed into Web Audio');
    delete window.AudioContext;
});

test('WebOSPlayer: play() without stop() reuses the graph and plays a movie at unity gain', async () => {
    window.AudioContext = StrictAudioContext;
    StrictAudioContext.instances = [];
    const { player } = createPlayer();

    await playAndStart(player, track(-6));
    await playAndStart(player, movie);

    assert.strictEqual(mediaContexts().length, 1);
    assert.strictEqual(player._audioGraph.gain.gain.value, 1);
    delete window.AudioContext;
});

test('WebOSPlayer: the user mute state survives the element swap', async () => {
    window.AudioContext = StrictAudioContext;
    const { player } = createPlayer();

    await playAndStart(player, track(-6));
    player._videoElement.muted = true;
    await player.stop();

    assert.strictEqual(player._videoElement.muted, true);
    delete window.AudioContext;
});

test('WebOSPlayer: the shared AudioContext is resumed for the next track and closed on destroy()', async () => {
    window.AudioContext = StrictAudioContext;
    StrictAudioContext.instances = [];
    const { player } = createPlayer();

    await playAndStart(player, track(-6));
    await player.stop();
    assert.strictEqual(mediaContexts()[0].state, 'suspended');

    await playAndStart(player, track(-6));
    assert.strictEqual(mediaContexts()[0].state, 'running');

    player.destroy();
    assert.strictEqual(mediaContexts()[0].closed, true);
    delete window.AudioContext;
});
