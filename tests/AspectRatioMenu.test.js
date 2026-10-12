import assert from 'node:assert/strict';
import test from 'node:test';

// Setup environment mocks
globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080
};
globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
};
globalThis.document = {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    createElement: () => ({
        classList: { add: () => {}, remove: () => {}, toggle: () => {} },
        addEventListener: () => {},
        querySelectorAll: () => [],
        appendChild: () => {},
        innerHTML: ''
    }),
    body: {
        appendChild: () => {}
    }
};

test('AspectRatioMenu: Omits Zoom option on Tizen and offers Auto, Video Aspect Ratio, and Stretch', async () => {
    // 1. Test Tizen platform detection
    globalThis.window.tizen = {};
    const { platformInfo } = await import('../src/utils/PlatformInfo.js');
    platformInfo._platform = 'tizen';

    const { default: AspectRatioMenu } = await import('../src/player/osd/AspectRatioMenu.js');

    const mockOsd = {
        player: {
            backendType: 'tizen',
            getAspectRatio: () => 'auto',
            setAspectRatio: () => {}
        },
        _getFocused: () => null,
        _currentFocusRow: 0,
        _currentFocusIndex: 0,
        _updateFocus: () => {}
    };

    const menu = new AspectRatioMenu(mockOsd);
    const optionsOnTizen = menu.options.map(opt => opt.id);

    assert.deepStrictEqual(
        optionsOnTizen,
        ['auto', 'video_aspect_ratio', 'stretch'],
        'On Tizen AVPlay, AspectRatioMenu must offer Auto, Video Aspect Ratio, and Stretch (Zoom must be hidden)'
    );
});

test('AspectRatioMenu: Retains Zoom option on non-Tizen platforms', async () => {
    // 2. Test non-Tizen platform
    delete globalThis.window.tizen;
    delete globalThis.window.webapis;

    const { platformInfo } = await import('../src/utils/PlatformInfo.js');
    platformInfo._platform = 'web';

    const { default: AspectRatioMenu } = await import('../src/player/osd/AspectRatioMenu.js');

    const mockOsd = {
        player: {
            getAspectRatio: () => 'auto',
            setAspectRatio: () => {}
        },
        _getFocused: () => null,
        _currentFocusRow: 0,
        _currentFocusIndex: 0,
        _updateFocus: () => {}
    };

    const menu = new AspectRatioMenu(mockOsd);
    const optionsOnWeb = menu.options.map(opt => opt.id);

    assert.deepStrictEqual(
        optionsOnWeb,
        ['auto', 'zoom', 'stretch'],
        'On non-Tizen platforms, AspectRatioMenu must retain Auto, Zoom, and Stretch'
    );
});

test('WebOSPlayer: Computes explicit layout bounding box geometry for auto, zoom, and stretch modes', async () => {
    // ------------------------------------------------------------------------
    // WebOS Player Architecture Verification
    // ------------------------------------------------------------------------
    // On webOS TV, CSS object-fit is not supported on hardware-backed <video>.
    // Verify that WebOSPlayer calculates and applies explicit layout bounding
    // box dimensions (width, height, left, top) for all supported modes.
    // ------------------------------------------------------------------------

    // Dynamically import WebOSPlayer backend
    const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');

    // Create a mock style object to record CSS properties
    const mockStyle = {};

    // Mock video element representing 2.40:1 ultrawide content (1920x800)
    const mockVideo = {
        videoWidth: 1920,
        videoHeight: 800,
        style: mockStyle
    };

    // Mock container representing a standard 1080p display viewport (1920x1080)
    const mockContainer = {
        clientWidth: 1920,
        clientHeight: 1080,
        appendChild: () => {}
    };

    // Instantiate WebOSPlayer instance with the mock container
    const player = new WebOSPlayer({ container: mockContainer });
    player._videoElement = mockVideo;

    // ------------------------------------------------------------------------
    // Case 1: Fullscreen Stretch Mode
    // ------------------------------------------------------------------------
    // Must force the bounding box to match the full container (1920x1080)
    player.setAspectRatio('stretch');
    assert.strictEqual(player.getAspectRatio(), 'stretch');
    assert.strictEqual(mockStyle.left, '0px');
    assert.strictEqual(mockStyle.top, '0px');
    assert.strictEqual(mockStyle.width, '1920px');
    assert.strictEqual(mockStyle.height, '1080px');
    assert.strictEqual(mockStyle.objectFit, 'fill');

    // ------------------------------------------------------------------------
    // Case 2: Auto (Letterbox / Contain) Mode
    // ------------------------------------------------------------------------
    // Scale = min(1920/1920, 1080/800) = 1.0
    // Width = 1920px, Height = 800px, Top = (1080 - 800) / 2 = 140px
    player.setAspectRatio('auto');
    assert.strictEqual(player.getAspectRatio(), 'auto');
    assert.strictEqual(mockStyle.width, '1920px');
    assert.strictEqual(mockStyle.height, '800px');
    assert.strictEqual(mockStyle.left, '0px');
    assert.strictEqual(mockStyle.top, '140px');

    // ------------------------------------------------------------------------
    // Case 3: Zoom (Crop / Cover) Mode
    // ------------------------------------------------------------------------
    // Scale = max(1920/1920, 1080/800) = 1.35
    // Width = round(1920 * 1.35) = 2592px, Height = round(800 * 1.35) = 1080px
    // Left = round((1920 - 2592) / 2) = -336px, Top = 0px
    player.setAspectRatio('zoom');
    assert.strictEqual(player.getAspectRatio(), 'zoom');
    assert.strictEqual(mockStyle.width, '2592px');
    assert.strictEqual(mockStyle.height, '1080px');
    assert.strictEqual(mockStyle.left, '-336px');
    assert.strictEqual(mockStyle.top, '0px');
});
