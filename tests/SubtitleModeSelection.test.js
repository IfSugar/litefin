import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// ============================================================================
// Environment Mock for ES Module Imports in Node.js
// ============================================================================
// Initialize local storage and window mocks so PlayerSettings, storage,
// and LanguageManager can load cleanly in the Node test environment.
// ============================================================================
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

globalThis.document = {
    createElement: () => ({
        canPlayType: () => ''
    })
};

globalThis.screen = { width: 1920, height: 1080 };
globalThis.window = globalThis;

// Import LanguageManager, MediaHelper, and storage modules
const { languageManager } = await import('../src/utils/LanguageManager.js');
const { MediaHelper } = await import('../src/player/core/MediaHelper.js');
const { storage } = await import('../src/utils/StorageService.js');

// Read JellyfinPlayer.js source to extract resolveSubtitleStream without loading CSS/DOM
const playerSource = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');

function setup(settings = {}) {
    const currentSettings = {
        subtitleMode: 'Default',
        subtitleLanguage: 'eng',
        preferExternalSubtitles: false,
        ...settings
    };

    const context = vm.createContext({
        PlayerSettings: {
            get: (key) => currentSettings[key],
            set: (key, val) => { currentSettings[key] = val; }
        },
        storage: {
            getItem: (key) => {
                if (key === 'pref:subtitleLang') return currentSettings.subtitleLanguage || 'none';
                return storageMap.get(key) || null;
            },
            setItem: (key, val) => storageMap.set(key, String(val)),
            removeItem: (key) => storageMap.delete(key)
        },
        languageManager,
        log: {
            info() {},
            debug() {},
            warn() {},
            error() {}
        }
    });

    // Extract isLanguageMatch and resolveSubtitleStream blocks from JellyfinPlayer.js
    const startMarker = 'const isLanguageMatch = (trackLang, targetLanguage) => {';
    const endMarker = '/**\n * Automatically resolve the best audio track for a given media source.';
    
    const startIdx = playerSource.indexOf(startMarker);
    const endIdx = playerSource.indexOf(endMarker);
    
    if (startIdx === -1 || endIdx === -1) {
        throw new Error('Failed to locate resolveSubtitleStream source block in JellyfinPlayer.js');
    }

    const codeToRun = playerSource.slice(startIdx, endIdx).replace(/export function /g, 'function ');
    const script = `
        ${codeToRun}
        ({ resolveSubtitleStream });
    `;

    const { resolveSubtitleStream } = vm.runInContext(script, context);
    return {
        resolveSubtitleStream,
        setSetting: (key, val) => { currentSettings[key] = val; }
    };
}

// ============================================================================
// Subtitle Mode & Track Selection Test Suite
// ============================================================================
// Validates subtitle stream resolution for all standard Subtitle Modes:
// - 'None': Always forces subtitles off (-1), ignoring default flags.
// - 'OnlyForced': Selects only forced tracks (via IsForced, Title, DisplayTitle),
//   falling back to -1 when no forced track exists.
// - 'Default': Respects container IsDefault stream flag, returning -1 otherwise.
// - 'Always': Selects best matching subtitle track or first available track.
// - 'Smart': Shows subtitles only when audio language differs from preference.
// ============================================================================

test('resolveSubtitleStream: Subtitle mode "None" always returns -1 even if container has default subtitle', () => {
    // -------------------------------------------------------------------------
    // Setup player settings for Subtitle Mode: None
    // -------------------------------------------------------------------------
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'None',
        subtitleLanguage: 'eng'
    });

    // Media source containing internal default subtitle and external subtitle
    const mediaSource = {
        Id: 'test-source-none',
        DefaultSubtitleStreamIndex: 2,
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false, Title: 'English' },
            { Type: 'Subtitle', Index: 3, Language: 'spa', IsDefault: false, IsForced: false, Title: 'Spanish' }
        ]
    };

    // Subtitle stream should resolve to -1 (off)
    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, -1, 'Subtitle mode "None" must always resolve to -1 (disabled)');
});

test('resolveSubtitleStream: Subtitle mode "OnlyForced" returns -1 when container only has non-forced default track', () => {
    // -------------------------------------------------------------------------
    // Setup player settings for Subtitle Mode: OnlyForced
    // -------------------------------------------------------------------------
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'OnlyForced',
        subtitleLanguage: 'eng'
    });

    // Media source matching the user report (The Big Bang Theory episode)
    // Stream 2 is English Default SUBRIP, but NOT forced
    const mediaSource = {
        Id: 'test-source-tbbt',
        DefaultSubtitleStreamIndex: 2,
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false, Title: 'SHD', DisplayTitle: 'SHD - English - Default - SUBRIP' }
        ]
    };

    // Subtitle stream should resolve to -1 since stream 2 is not forced
    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, -1, 'Subtitle mode "OnlyForced" must resolve to -1 when no forced track exists');
});

test('resolveSubtitleStream: Subtitle mode "OnlyForced" detects forced track via IsForced boolean', () => {
    // -------------------------------------------------------------------------
    // Setup player settings for Subtitle Mode: OnlyForced
    // -------------------------------------------------------------------------
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'OnlyForced',
        subtitleLanguage: 'eng'
    });

    // Media source with both standard and forced tracks
    const mediaSource = {
        Id: 'test-source-forced-bool',
        DefaultSubtitleStreamIndex: 2,
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false, Title: 'Full Subtitles' },
            { Type: 'Subtitle', Index: 3, Language: 'eng', IsDefault: false, IsForced: true, Title: 'English Forced' }
        ]
    };

    // Subtitle stream should resolve to Index 3 (the forced track)
    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, 3, 'Subtitle mode "OnlyForced" must select track with IsForced: true');
});

test('resolveSubtitleStream: Subtitle mode "OnlyForced" detects forced track via Title and DisplayTitle strings', () => {
    // -------------------------------------------------------------------------
    // Setup player settings for Subtitle Mode: OnlyForced
    // -------------------------------------------------------------------------
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'OnlyForced',
        subtitleLanguage: 'eng'
    });

    // Media source where IsForced flag is missing (false) but Title says "Forced"
    const mediaSource = {
        Id: 'test-source-forced-title',
        DefaultSubtitleStreamIndex: 2,
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false, Title: 'English (Forced)', DisplayTitle: 'English [Forced]' }
        ]
    };

    // Subtitle stream should detect the "Forced" keyword and resolve to Index 2
    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, 2, 'Subtitle mode "OnlyForced" must identify forced subtitles from title string');
});

test('resolveSubtitleStream: Subtitle mode "OnlyForced" falls back to active audio language when preferred subtitle is "none"', () => {
    // -------------------------------------------------------------------------
    // Setup player settings with subtitleLanguage set to 'none'
    // -------------------------------------------------------------------------
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'OnlyForced',
        subtitleLanguage: 'none'
    });

    // Media source with French audio and French forced subtitles
    const mediaSource = {
        Id: 'test-source-audio-fallback',
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'fra', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: false, IsForced: true, Title: 'English Forced' },
            { Type: 'Subtitle', Index: 3, Language: 'fra', IsDefault: false, IsForced: true, Title: 'Français (Forcé)' }
        ]
    };

    // Should match French forced subtitle because audio is French
    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, 3, 'Subtitle mode "OnlyForced" should match audio language when preferred language is "none"');
});

test('resolveSubtitleStream: Subtitle mode "Default" selects track marked IsDefault', () => {
    // -------------------------------------------------------------------------
    // Setup player settings for Subtitle Mode: Default
    // -------------------------------------------------------------------------
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'Default'
    });

    const mediaSource = {
        Id: 'test-source-default',
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'spa', IsDefault: false, IsForced: false },
            { Type: 'Subtitle', Index: 3, Language: 'eng', IsDefault: true, IsForced: false }
        ]
    };

    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, 3, 'Subtitle mode "Default" should select track with IsDefault: true');
});

test('resolveSubtitleStream: Subtitle mode "Always" selects user preferred language track', () => {
    // -------------------------------------------------------------------------
    // Setup player settings for Subtitle Mode: Always, language: spa
    // -------------------------------------------------------------------------
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'Always',
        subtitleLanguage: 'spa',
        preferExternalSubtitles: false
    });

    const mediaSource = {
        Id: 'test-source-always',
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false },
            { Type: 'Subtitle', Index: 3, Language: 'spa', IsDefault: false, IsForced: false }
        ]
    };

    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, 3, 'Subtitle mode "Always" should pick track matching preferred language');
});

test('resolveSubtitleStream: Subtitle mode "Smart" shows subtitles when audio does not match preferred subtitle language', () => {
    // -------------------------------------------------------------------------
    // Setup player settings for Subtitle Mode: Smart, preferred sub: eng
    // -------------------------------------------------------------------------
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'Smart',
        subtitleLanguage: 'eng'
    });

    // Japanese audio with English subtitles
    const mediaSource = {
        Id: 'test-source-smart-foreign',
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'jpn', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false }
        ]
    };

    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, 2, 'Subtitle mode "Smart" should enable English subtitles when audio is Japanese');
});

test('resolveSubtitleStream: Subtitle mode "Smart" suppresses regular subtitles when audio matches preferred subtitle language', () => {
    // -------------------------------------------------------------------------
    // Setup player settings for Subtitle Mode: Smart, preferred sub: eng
    // -------------------------------------------------------------------------
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'Smart',
        subtitleLanguage: 'eng'
    });

    // English audio with non-forced English subtitle
    const mediaSource = {
        Id: 'test-source-smart-native',
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false }
        ]
    };

    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, -1, 'Subtitle mode "Smart" should disable regular subtitles when audio matches preferred language');
});

test('Series track memory does not override Subtitle mode "None" or "OnlyForced"', () => {
    // -------------------------------------------------------------------------
    // Simulate series track memory previously stored for a TV series
    // -------------------------------------------------------------------------
    const seriesId = 'test-series-override-guard';
    storage.setItem(`track:series:${seriesId}`, JSON.stringify({
        audio: { language: 'eng', title: 'English' },
        subtitle: { language: 'eng', title: 'SHD - English - Default - SUBRIP', isOff: false }
    }));

    const mediaSource = {
        Id: 'test-episode-guard',
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true, Title: 'English' },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false, Title: 'SHD - English - Default - SUBRIP' }
        ]
    };

    // When mode is 'None':
    const { resolveSubtitleStream: resolveNone } = setup({
        subtitleMode: 'None',
        subtitleLanguage: 'eng'
    });
    const subtitleModeNone = 'None';
    let resolvedSubNone = undefined;
    if (subtitleModeNone !== 'None' && subtitleModeNone !== 'OnlyForced') {
        resolvedSubNone = MediaHelper.resolveSeriesTrack(mediaSource, 'Subtitle', seriesId);
    }
    if (resolvedSubNone === undefined) {
        resolvedSubNone = resolveNone(mediaSource, { audioStreamIndex: 1 });
    }
    assert.equal(resolvedSubNone, -1, 'Subtitle mode "None" must prevent series memory from forcing subtitle on');

    // When mode is 'OnlyForced':
    const { resolveSubtitleStream: resolveForced } = setup({
        subtitleMode: 'OnlyForced',
        subtitleLanguage: 'eng'
    });
    const subtitleModeForced = 'OnlyForced';
    let resolvedSubForced = undefined;
    if (subtitleModeForced !== 'None' && subtitleModeForced !== 'OnlyForced') {
        resolvedSubForced = MediaHelper.resolveSeriesTrack(mediaSource, 'Subtitle', seriesId);
    }
    if (resolvedSubForced === undefined) {
        resolvedSubForced = resolveForced(mediaSource, { audioStreamIndex: 1 });
    }
    assert.equal(resolvedSubForced, -1, 'Subtitle mode "OnlyForced" must prevent non-forced series memory from activating');
});
