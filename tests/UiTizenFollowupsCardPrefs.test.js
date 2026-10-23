import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * Media Card Preferences Test Suite
 * ============================================================================
 * A row or grid renders all its cards in one synchronous loop. Every storage
 * read parses the whole per-user settings object when settings are per user,
 * so the preferences that shape a card are read once per render pass instead
 * of once per card, and a changed setting still shows on the next render.
 * ============================================================================
 */

const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};
globalThis.document = {
    createElement: () => ({
        getContext: () => ({}),
        setAttribute: () => {},
        removeAttribute: () => {},
        classList: { add: () => {}, remove: () => {}, contains: () => false }
    }),
    documentElement: {
        setAttribute: () => {},
        removeAttribute: () => {},
        getAttribute: (name) => (name === 'data-layout-media-rows' ? 'expanding' : null),
        hasAttribute: () => false
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => []
};
globalThis.window = globalThis;
globalThis.__APP_VERSION__ = '1.0.0';

const { storage } = await import('../src/utils/StorageService.js');
const { default: CardRenderer } = await import('../src/utils/CardRenderer.js');

const favoriteMovie = (id) => ({
    Id: id,
    Name: `Movie ${id}`,
    Type: 'Movie',
    ProductionYear: 2024,
    MediaSourceCount: 2,
    ImageTags: { Primary: 'tag' },
    UserData: { IsFavorite: true, Played: true }
});

const CARD_PREF_KEYS = [
    'pref:libraryThumbMode',
    'pref:preferBackdropsOverThumbs',
    'litefin:disableBlurhash',
    'pref:disableLibraryBlurhash',
    'pref:hideLibraryLabels',
    'pref:cardLabelStyle',
    'pref:preferEpisodeImagesLocal',
    'pref:hideProgressBar',
    'pref:hideEpisodeCounts',
    'pref:showMediaSourceCounts',
    'pref:useEpisodeBadges',
    'pref:useSeasonBadges',
    'pref:swapEpisodeTitles',
    'pref:showFavoriteBadges',
    'pref:showQualityBadges'
];

function countCardPrefReads(fn) {
    const counts = new Map();
    const original = storage.getItem;
    storage.getItem = function (key) {
        if (CARD_PREF_KEYS.includes(key)) counts.set(key, (counts.get(key) || 0) + 1);
        return original.call(this, key);
    };
    try {
        fn();
    } finally {
        storage.getItem = original;
    }
    return counts;
}

const episode = (id) => ({
    Id: id,
    Name: `Episode ${id}`,
    Type: 'Episode',
    SeriesName: 'Series',
    SeriesId: 'series-1',
    ParentIndexNumber: 1,
    IndexNumber: 2,
    RunTimeTicks: 60000000000,
    ImageTags: { Primary: 'tag' },
    UserData: { IsFavorite: true, PlaybackPositionTicks: 20000000000 }
});

test('CardRenderer: card preferences are read once per render pass, not per card', async () => {
    await Promise.resolve(); // start from a fresh pass
    CardRenderer.clearCache();

    // A row of 12 posters, then a resume row of 12 episodes, in one pass (cache misses)
    const missReads = countCardPrefReads(() => {
        for (let i = 0; i < 12; i++) CardRenderer.createCardHtml(favoriteMovie(`m${i}`), { type: 'poster' });
        for (let i = 0; i < 12; i++) {
            CardRenderer.createCardHtml(episode(`e${i}`), { type: 'resume', contextType: 'resume', isLandscape: true });
        }
    });
    for (const [key, count] of missReads) assert.equal(count, 1, `${key} read ${count} times in one pass`);
    assert.ok(missReads.size > 0);

    // The same row again in a later pass: cache hits only
    await Promise.resolve();
    const hitReads = countCardPrefReads(() => {
        for (let i = 0; i < 12; i++) CardRenderer.createCardHtml(favoriteMovie(`m${i}`), { type: 'poster' });
    });
    for (const [key, count] of hitReads) assert.equal(count, 1, `${key} read ${count} times on cache hits`);
});

test('CardRenderer: a changed setting applies to the next render pass and after clearCache()', async () => {
    await Promise.resolve();
    storage.removeItem('pref:showFavoriteBadges');
    CardRenderer.clearCache();
    try {
        assert.doesNotMatch(CardRenderer.createCardHtml(favoriteMovie('p1'), { type: 'poster' }), /favorite-badge/);

        // Settings screen, later task: the next pass reads the new value
        storage.setItem('pref:showFavoriteBadges', 'true');
        await Promise.resolve();
        assert.match(CardRenderer.createCardHtml(favoriteMovie('p2'), { type: 'poster' }), /favorite-badge/);

        // Same task: clearCache(), which settings call when a card option changes, drops the snapshot
        storage.setItem('pref:showFavoriteBadges', 'false');
        CardRenderer.clearCache();
        assert.doesNotMatch(CardRenderer.createCardHtml(favoriteMovie('p3'), { type: 'poster' }), /favorite-badge/);
    } finally {
        storage.removeItem('pref:showFavoriteBadges');
        CardRenderer.clearCache();
    }
});
