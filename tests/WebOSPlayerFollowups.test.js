import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player Follow-up Test Suite
 * ============================================================================
 * Smaller fixes in the native webOS player:
 *   - the video box is written only when it changes (A8)
 *   - one TV video-window request at a time, with a slower refresh (A8)
 *   - canPlayType probes are not repeated on every play (A8)
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// Minimal DOM: <video>/<source> stand-ins that can fire events
// ----------------------------------------------------------------------------

const GEOMETRY_KEYS = ['position', 'margin', 'left', 'top', 'right', 'bottom', 'width', 'height', 'objectFit', 'objectPosition'];

/** Inline style stand-in that counts writes of the video box geometry */
function createStyle() {
    let geometryWrites = 0;
    return new Proxy({}, {
        get: (target, key) => (key === 'geometryWrites' ? geometryWrites : target[key]),
        set(target, key, value) {
            if (GEOMETRY_KEYS.includes(key)) geometryWrites++;
            target[key] = value;
            return true;
        }
    });
}

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
        style: createStyle(),
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
const { platformInfo } = await import('../src/utils/PlatformInfo.js');

const mediaSource = {
    Container: 'mkv',
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'h264' },
        { Index: 1, Type: 'Audio', Codec: 'aac', Language: 'eng', Channels: 2, IsDefault: true }
    ]
};
// Native-only HLS (HEVC HDR + E-AC-3): Hls.js cannot take over
const nativeOnlyHls = {
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'hevc', VideoRangeType: 'HDR10' },
        { Index: 1, Type: 'Audio', Codec: 'eac3', IsDefault: true }
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
// A8 — layout and Luna churn
// ----------------------------------------------------------------------------

test('WebOSPlayer: the video box is written only when it changes', async () => {
    const { player, container } = createPlayer();
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mkv', mediaSource });
    const video = player._videoElement;
    video.fire('loadedmetadata');
    const style = video.style;
    assert.strictEqual(style.width, '1920px');
    const written = style.geometryWrites;

    // Every seek, unpause and rebuffer fires 'playing' (and a seek also refits from 'seeked')
    for (let i = 0; i < 5; i++) video.fire('playing');
    video.fire('resize');
    assert.strictEqual(style.geometryWrites, written, 'unchanged video box written again');

    container.clientWidth = 1280;
    container.clientHeight = 720;
    player._fitVideoBox();
    assert.strictEqual(style.width, '1280px');
    assert.strictEqual(style.height, '720px');

    player.setAspectRatio('stretch');
    assert.strictEqual(style.objectFit, 'fill');
    assert.strictEqual(style.right, '0px');
    player.setAspectRatio('auto');
    assert.strictEqual(style.objectFit, 'contain');
    assert.strictEqual(style.right, '');

    // The next item on the same element keeps a correct box
    await player.stop();
    await playAndStart(player, { url: 'http://srv/Videos/b/stream.mkv', mediaSource });
    player._videoElement.videoWidth = 1440;
    player._videoElement.fire('loadedmetadata');
    assert.strictEqual(player._videoElement.style.width, '960px');
    assert.strictEqual(player._videoElement.style.left, '160px');
});

/** Old webOS (Chromium < 79) with the Luna bridge: aspect modes go through the TV's video output service */
function useLunaOutputWindow(t) {
    const pending = [];
    const sent = [];
    globalThis.window.PalmServiceBridge = class {
        call(uri, params) {
            sent.push({ uri, params: JSON.parse(params) });
            pending.push(this);
        }
        cancel() {}
    };
    const chromeVersion = platformInfo._chromeVersion;
    platformInfo._chromeVersion = 68;
    t.after(() => {
        platformInfo._chromeVersion = chromeVersion;
        delete globalThis.window.PalmServiceBridge;
    });
    return {
        sent,
        pending,
        async replyAll(reply = { returnValue: true }) {
            while (pending.length) pending.shift().onservicecallback(JSON.stringify(reply));
            for (let i = 0; i < 4; i++) await flush();
        }
    };
}

async function zoomedPlayback(player) {
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mkv', mediaSource });
    const video = player._videoElement;
    video.mediaId = 'pipeline-1';
    video.videoWidth = 1920;
    video.videoHeight = 800;
    player._aspectMode = 'zoom';
    return video;
}

test('WebOSPlayer: one TV video-window request at a time', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const luna = useLunaOutputWindow(t);
    const { player } = createPlayer();
    const video = await zoomedPlayback(player);

    // loadedmetadata, canplay and playing each refit while the first request is in flight
    player._fitVideoBox();
    video.fire('playing');
    video.fire('resize');
    assert.strictEqual(luna.sent.length, 1, 'concurrent setDisplayWindow requests');

    await luna.replyAll();
    assert.strictEqual(luna.sent.length, 2, 'the refits made meanwhile are sent once, afterwards');
    await luna.replyAll();
    assert.strictEqual(luna.sent.length, 2);
    assert.strictEqual(luna.sent[1].uri, 'luna://com.webos.service.videooutput/display/setDisplayWindow');
    await player.stop();
});

test('WebOSPlayer: an accepted TV video window is refreshed every 30 s once settled', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const luna = useLunaOutputWindow(t);
    const { player } = createPlayer();
    await zoomedPlayback(player);
    player._fitVideoBox();
    await luna.replyAll();

    let sentAfterOneMinute = 0;
    for (let s = 1; s <= 120; s++) {
        t.mock.timers.tick(1000);
        await luna.replyAll();
        if (s === 60) sentAfterOneMinute = luna.sent.length;
    }
    // Was every 3 s for the whole playback: 20 Luna calls a minute
    assert.ok(luna.sent.length - sentAfterOneMinute <= 2, `${luna.sent.length - sentAfterOneMinute} refreshes in the second minute`);
    assert.ok(luna.sent.length >= 6, 'the first refreshes still come every 3 s');
    await player.stop();
});

test('WebOSPlayer: canPlayType is asked once per MIME type, not on every play', async () => {
    // The Dolby Vision direct-play path probes 'video/mp4; codecs="dvh1"' before each load
    const doviSource = {
        Container: 'mp4',
        MediaStreams: [
            { Index: 0, Type: 'Video', Codec: 'hevc', VideoRangeType: 'DOVI' },
            { Index: 1, Type: 'Audio', Codec: 'aac', IsDefault: true }
        ]
    };
    const { player } = createPlayer();
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mp4', mediaSource: doviSource });
    const created = createdVideos.length;
    await player.stop();
    await playAndStart(player, { url: 'http://srv/Videos/b/stream.mp4', mediaSource: doviSource });
    await player.stop();
    await playAndStart(player, { url: 'http://srv/Videos/c/stream.mp4', mediaSource: doviSource });
    assert.strictEqual(createdVideos.length, created, 'a throw-away <video> per play');
});
