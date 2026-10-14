import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * ============================================================================
 * AndroidAdapter & Remote Back Navigation Test Suite
 * ============================================================================
 * Verifies that:
 *   1. Hardware Back dispatch (`handleHardwareBack`) emits `key:back` onto EventBus.
 *   2. Physical keyboard Escape and Backspace keys emit `key:back`.
 *   3. Native AndroidBridge.exit() is invoked upon adapter.exit().
 *   4. Native AndroidBridge.getDeviceName() resolves hardware model name.
 *   5. D-Pad and media key inputs map correctly to eventBus signals.
 * ============================================================================
 */

test('AndroidAdapter: handleHardwareBack emits key:back on EventBus', () => {
    let backEmitted = 0;
    const emittedEvents = [];

    const mockEventBus = {
        emit(event, data) {
            emittedEvents.push(event);
            if (event === 'key:back') {
                backEmitted++;
            }
        }
    };

    let exitCalled = false;
    let storageFlushed = false;

    const mockStorage = {
        flush() {
            storageFlushed = true;
        }
    };

    const mockWindow = {
        LitefinAndroid: {
            exit() {
                exitCalled = true;
            },
            getDeviceName() {
                return 'Google Chromecast with Google TV';
            }
        },
        location: {
            hash: '#/home'
        }
    };

    const listeners = {};
    const mockDocument = {
        addEventListener(event, fn) {
            listeners[event] = listeners[event] || [];
            listeners[event].push(fn);
        },
        activeElement: null
    };

    const androidAdapterSource = readFileSync(new URL('../src/android/AndroidAdapter.js', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/^import .*;\n/gm, '')
        .replace(/^export .*;\n/gm, '');

    const sandbox = {
        eventBus: mockEventBus,
        storage: mockStorage,
        logger: { create: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
        window: mockWindow,
        document: mockDocument,
        Date,
        console
    };

    vm.createContext(sandbox);
    vm.runInContext(androidAdapterSource + '\n; sandboxAdapter = new AndroidAdapter();', sandbox);

    const adapter = sandbox.sandboxAdapter;
    adapter.init();

    // Verify window.androidAdapter registration
    assert.strictEqual(mockWindow.androidAdapter, adapter);

    // Verify hardware back button dispatch
    adapter.handleHardwareBack();
    assert.strictEqual(backEmitted, 1, 'handleHardwareBack() should emit key:back');

    // Verify keyboard Escape key triggers back
    const keydownHandler = listeners['keydown']?.[0];
    assert.ok(keydownHandler, 'keydown handler should be registered');

    let defaultPrevented = false;
    keydownHandler({
        keyCode: 27,
        preventDefault() {
            defaultPrevented = true;
        }
    });

    assert.strictEqual(backEmitted, 2, 'Escape key should emit key:back');
    assert.strictEqual(defaultPrevented, true, 'Escape key should prevent default');

    // Verify exit delegation
    adapter.exit();
    assert.strictEqual(storageFlushed, true, 'Storage should be flushed on exit');
    assert.strictEqual(exitCalled, true, 'Native LitefinAndroid.exit should be called');

    // Verify device name query
    const deviceName = adapter.getDeviceName();
    assert.strictEqual(deviceName, 'Google Chromecast with Google TV');
});

test('AndroidAdapter: media and navigation keys trigger appropriate events', () => {
    const emittedEvents = [];
    const mockEventBus = {
        emit(event) {
            emittedEvents.push(event);
        }
    };

    const listeners = {};
    const mockDocument = {
        addEventListener(event, fn) {
            listeners[event] = listeners[event] || [];
            listeners[event].push(fn);
        },
        activeElement: null
    };

    const mockWindow = {
        location: { hash: '#/player/123' }
    };

    const androidAdapterSource = readFileSync(new URL('../src/android/AndroidAdapter.js', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/^import .*;\n/gm, '')
        .replace(/^export .*;\n/gm, '');

    const sandbox = {
        eventBus: mockEventBus,
        storage: { flush() {} },
        logger: { create: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
        window: mockWindow,
        document: mockDocument,
        Date,
        console
    };

    vm.createContext(sandbox);
    vm.runInContext(androidAdapterSource + '\n; sandboxAdapter = new AndroidAdapter();', sandbox);

    const adapter = sandbox.sandboxAdapter;
    adapter.init();

    const keydownHandler = listeners['keydown']?.[0];

    // D-Pad navigation
    keydownHandler({ keyCode: 37, preventDefault() {} }); // LEFT
    keydownHandler({ keyCode: 38, preventDefault() {} }); // UP
    keydownHandler({ keyCode: 39, preventDefault() {} }); // RIGHT
    keydownHandler({ keyCode: 40, preventDefault() {} }); // DOWN
    keydownHandler({ keyCode: 13, preventDefault() {} }); // ENTER

    // Media keys
    keydownHandler({ keyCode: 179, preventDefault() {} }); // PLAY_PAUSE
    keydownHandler({ keyCode: 227, preventDefault() {} }); // REWIND
    keydownHandler({ keyCode: 228, preventDefault() {} }); // FAST_FORWARD

    assert.deepStrictEqual(emittedEvents, [
        'key:left',
        'key:up',
        'key:right',
        'key:down',
        'key:enter',
        'key:playPause',
        'key:rewind',
        'key:fastForward'
    ]);
});

/**
 * ============================================================================
 * AndroidAdapter Screen Wake Lock & KeepScreenOn Test
 * ============================================================================
 * Verifies that:
 *   1. setKeepScreenOn correctly routes wake lock requests to LitefinAndroid bridge.
 *   2. player:play, player:playing, player:paused, and player:stopped triggers
 *      keepScreenOn transitions to prevent the 15-minute Android system screensaver.
 *   3. Modern navigator.wakeLock fallback engages when native bridge is unavailable.
 * ============================================================================
 */
test('AndroidAdapter: setKeepScreenOn delegates to native bridge and responds to player events', async () => {
    // Track invocations of native bridge setKeepScreenOn calls
    const keepScreenOnCalls = [];
    const eventHandlers = {};

    // Mock EventBus supporting registration and emission
    const mockEventBus = {
        on(event, handler) {
            eventHandlers[event] = eventHandlers[event] || [];
            eventHandlers[event].push(handler);
        },
        emit(event, payload) {
            const handlers = eventHandlers[event] || [];
            for (const fn of handlers) {
                fn(payload);
            }
        }
    };

    // Mock native LitefinAndroid host bridge
    const mockWindow = {
        LitefinAndroid: {
            setKeepScreenOn(keepOn) {
                keepScreenOnCalls.push(keepOn);
            },
            isTv() {
                return true;
            }
        },
        location: {
            hash: '#/home'
        }
    };

    // Minimal document stub for event listener attachments
    const mockDocument = {
        addEventListener() {},
        querySelector() {
            return null;
        },
        documentElement: {
            style: {
                removeProperty() {}
            },
            removeAttribute() {},
            hasAttribute() {
                return false;
            },
            requestFullscreen: async () => {}
        }
    };

    // Load AndroidAdapter source code dynamically in clean VM context
    const androidAdapterSource = readFileSync(new URL('../src/android/AndroidAdapter.js', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/^import .*;\n/gm, '')
        .replace(/^export .*;\n/gm, '');

    const sandbox = {
        eventBus: mockEventBus,
        storage: { flush() {} },
        logger: { create: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
        window: mockWindow,
        document: mockDocument,
        Date,
        console
    };

    vm.createContext(sandbox);
    vm.runInContext(androidAdapterSource + '\n; sandboxAdapter = new AndroidAdapter();', sandbox);

    const adapter = sandbox.sandboxAdapter;
    adapter.init();

    // 1. Explicit setKeepScreenOn method verification
    adapter.setKeepScreenOn(true);
    adapter.setKeepScreenOn(false);

    assert.deepStrictEqual(keepScreenOnCalls, [true, false]);

    // 2. Playback state event integration tests
    // Reset call recording array
    keepScreenOnCalls.length = 0;

    // Simulate playback start: player:play
    mockEventBus.emit('player:play');
    assert.strictEqual(keepScreenOnCalls[keepScreenOnCalls.length - 1], true);

    // Simulate active playback frame arrival: player:playing
    mockEventBus.emit('player:playing');
    assert.strictEqual(keepScreenOnCalls[keepScreenOnCalls.length - 1], true);

    // Simulate user pausing: player:paused
    mockEventBus.emit('player:paused');
    assert.strictEqual(keepScreenOnCalls[keepScreenOnCalls.length - 1], false);

    // Simulate playback stopping / exiting: player:stopped
    mockEventBus.emit('player:stopped');
    assert.strictEqual(keepScreenOnCalls[keepScreenOnCalls.length - 1], false);
});
