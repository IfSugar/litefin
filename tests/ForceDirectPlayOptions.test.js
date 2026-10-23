import assert from 'node:assert/strict';
import test from 'node:test';

// Polyfill minimal browser DOM globals for Node test environment
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.has(key) ? storageMap.get(key) : null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear(),
    key: (i) => Array.from(storageMap.keys())[i] ?? null,
    get length() { return storageMap.size; }
};

globalThis.document = {
    createElement: () => ({
        canPlayType: () => 'probably'
    }),
    addEventListener: () => {}
};

globalThis.screen = { width: 1920, height: 1080 };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};

// Dynamic import after browser environment is polyfilled
const { storage } = await import('../src/utils/StorageService.js');
const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');

/**
 * ============================================================================
 * Force Direct Play Granular Options Test Suite
 * ============================================================================
 * Tests the 3 dropdown modes (Video Only, Audio Only, Everything) plus Disabled,
 * verifying that the existing storage key 'forceDirectPlay' is preserved and
 * that legacy boolean preferences ('true' / 'false') resolve without modifying
 * or breaking user configurations.
 * ============================================================================
 */

test('PlayerSettings: forceDirectPlay defaults to off', () => {
    // Clear storage before checking default
    storage.removeItem('player:forceDirectPlay');
    // Ensure default returns 'off'
    const val = PlayerSettings.get('forceDirectPlay');
    assert.equal(val, 'off');
});

test('PlayerSettings: legacy boolean true migrates seamlessly to all', () => {
    // Directly simulate legacy stored 'true' flag in storage
    storage.setItem('player:forceDirectPlay', 'true');
    // Read through PlayerSettings.get
    const resolved = PlayerSettings.get('forceDirectPlay');
    // Existing users with toggle active must continue to direct play everything
    assert.equal(resolved, 'all');
});

test('PlayerSettings: legacy boolean false migrates seamlessly to off', () => {
    // Directly simulate legacy stored 'false' flag in storage
    storage.setItem('player:forceDirectPlay', 'false');
    // Read through PlayerSettings.get
    const resolved = PlayerSettings.get('forceDirectPlay');
    // Existing users with toggle disabled must continue to have it off
    assert.equal(resolved, 'off');
});

test('PlayerSettings: granular modes video, audio, and all are preserved', () => {
    // Test video mode
    PlayerSettings.set('forceDirectPlay', 'video');
    assert.equal(PlayerSettings.get('forceDirectPlay'), 'video');
    assert.equal(storage.getItem('player:forceDirectPlay'), 'video');

    // Test audio mode
    PlayerSettings.set('forceDirectPlay', 'audio');
    assert.equal(PlayerSettings.get('forceDirectPlay'), 'audio');
    assert.equal(storage.getItem('player:forceDirectPlay'), 'audio');

    // Test all mode
    PlayerSettings.set('forceDirectPlay', 'all');
    assert.equal(PlayerSettings.get('forceDirectPlay'), 'all');
    assert.equal(storage.getItem('player:forceDirectPlay'), 'all');

    // Test off mode
    PlayerSettings.set('forceDirectPlay', 'off');
    assert.equal(PlayerSettings.get('forceDirectPlay'), 'off');
    assert.equal(storage.getItem('player:forceDirectPlay'), 'off');

    // Test boolean setter compatibility
    PlayerSettings.set('forceDirectPlay', true);
    assert.equal(PlayerSettings.get('forceDirectPlay'), 'all');

    PlayerSettings.set('forceDirectPlay', false);
    assert.equal(PlayerSettings.get('forceDirectPlay'), 'off');
});
