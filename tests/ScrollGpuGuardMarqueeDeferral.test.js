import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * ============================================================================
 * ScrollController GPU scrollTop Guard & LazyLoader Marquee Deferral Tests
 * ============================================================================
 * Verifies that:
 * 1. The GPU scroll animation loop never writes `container.scrollTop = 0`
 *    unconditionally — the write must be guarded so a clean layout tree is
 *    not dirtied on every ~16ms compositor frame during 3d-transform scrolling.
 * 2. The animation completion branch applies the same guard.
 * 3. LazyLoader defers the marquee overflow measurement (scrollWidth /
 *    clientWidth reads force synchronous reflow) while a scroll transition is
 *    in flight, stashing the focused card in _pendingMarqueeTarget.
 * 4. Deferred marquee checks are flushed from BOTH scroll-settle paths:
 *    the native scroll debounce (150ms) and the 'scroll:finished' listener.
 * 5. The extracted _checkTextMarquee keeps the focus guard so stale targets
 *    are dropped instead of animating after focus has moved on.
 * ============================================================================
 */

test('ScrollController: GPU animation loop guards container.scrollTop writes', () => {
    const source = readFileSync(new URL('../src/ui/ScrollController.js', import.meta.url), 'utf8');

    // 1. The guarded write pattern must exist (per-frame branch + completion branch)
    const guardedCount = (source.match(/if \(container\.scrollTop !== 0\) \{\s*container\.scrollTop = 0;/g) || []).length;
    assert.strictEqual(
        guardedCount >= 2,
        true,
        `container.scrollTop = 0 must be guarded by an offset check in at least 2 places (found ${guardedCount})`
    );

    // 2. Inside the RAF animate loop, the GPU branch must NOT contain a bare
    //    unconditional scrollTop write. Extract the animate loop body.
    const animateMatch = source.match(/const animate = \(time\) => \{([\s\S]*?)\n {8}this\[animIdKey\] = requestAnimationFrame\(animate\);/);
    assert.ok(animateMatch, 'GPU scroll animate loop must exist');
    const animateBody = animateMatch[1];

    // Every scrollTop = 0 write inside the loop must be preceded by the guard check
    const bareWritePattern = /(^|\n)[ \t]*container\.scrollTop = 0;/;
    const bareWrite = animateBody.match(
        new RegExp(`${bareWritePattern.source.replace('container\\.scrollTop = 0;', '')}(?<!!== 0\\) \\{\\n[\\s\\S]{0,600})container\\.scrollTop = 0;`)
    );
    // Simple, robust structural check instead: the guard check must appear
    // before EVERY scrollTop = 0 occurrence in the loop body.
    const writePositions = [...animateBody.matchAll(/container\.scrollTop = 0;/g)].map((m) => m.index);
    assert.strictEqual(
        writePositions.length > 0,
        true,
        'GPU branch of the animate loop must still clamp the container to 0'
    );
    const guardPositions = [...animateBody.matchAll(/container\.scrollTop !== 0/g)].map((m) => m.index);
    for (const pos of writePositions) {
        const guarding = guardPositions.some((g) => g < pos && pos - g < 300);
        assert.strictEqual(
            guarding,
            true,
            'Every container.scrollTop = 0 write in the animate loop must be preceded by an !== 0 guard'
        );
    }

    // 3. Performance rationale comment must document why the guard exists
    assert.strictEqual(
        source.includes('Writing scrollTop dirties the layout tree even when the'),
        true,
        'The guarded write must carry the PERFORMANCE rationale comment'
    );
});

test('LazyLoader: marquee measurement is deferred while scroll transitions are in flight', () => {
    const source = readFileSync(new URL('../src/utils/LazyLoader.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

    // 1. Pending target state is declared
    assert.strictEqual(
        source.includes('this._pendingMarqueeTarget = null;'),
        true,
        '_pendingMarqueeTarget must be initialized in the constructor'
    );

    // 2. The focus:changed RAF defers the layout query when scrolling is active.
    //    Extract the deferred marquee requestAnimationFrame block.
    const deferredMatch = source.match(
        /requestAnimationFrame\(\(\) => \{[\s\S]*?Guard against focus having already left the card[\s\S]*?\}\);\s*\}\s*\}/
    );
    assert.ok(deferredMatch, 'The deferred marquee RAF block must exist in the focus:changed handler');
    const rafBody = deferredMatch[0];
    assert.strictEqual(
        rafBody.includes('this._isScrolling()'),
        true,
        'The marquee RAF must check _isScrolling() before forcing layout'
    );
    assert.strictEqual(
        rafBody.includes('this._pendingMarqueeTarget = target;'),
        true,
        'The marquee RAF must stash the target when a scroll transition is active'
    );
    // The layout-forcing reads must NOT run inline in the deferred RAF anymore
    assert.strictEqual(
        rafBody.includes('span.scrollWidth'),
        false,
        'scrollWidth must not be read at frame 1 of a scroll transition'
    );

    // 3. Extracted measurement helper exists with focus + connectivity guards
    const checkMatch = source.match(/_checkTextMarquee\(target\) \{([\s\S]*?)\n {4}\}/);
    assert.ok(checkMatch, '_checkTextMarquee must be defined');
    const checkBody = checkMatch[1];
    assert.strictEqual(checkBody.includes("target.classList.contains('focused')"), true,
        '_checkTextMarquee must guard against focus having left the card');
    assert.strictEqual(checkBody.includes('scrollW = span.scrollWidth'), true,
        '_checkTextMarquee must read span.scrollWidth');
    assert.strictEqual(checkBody.includes("el.classList.add('marquee-active')"), true,
        '_checkTextMarquee must engage the marquee class on overflow');

    // 4. Flush helper exists and is invoked from BOTH settle paths
    assert.strictEqual(
        source.includes('_flushPendingMarquee() {\n        if (!this._pendingMarqueeTarget) return;'),
        true,
        '_flushPendingMarquee must exist and bail when nothing is pending'
    );
    const flushCalls = (source.match(/this\._flushPendingMarquee\(\);/g) || []).length;
    assert.strictEqual(
        flushCalls >= 2,
        true,
        `Deferred marquee flush must be wired into both scroll-settle paths (found ${flushCalls} call sites)`
    );

    // 5. One flush call must live in the native scroll debounce, the other
    //    inside the scroll:finished listener (both share the settle condition).
    const debounceBlock = source.match(/this\._scrollTimeout = setTimeout\(\(\) => \{[\s\S]*?\}, 150\);/);
    assert.ok(debounceBlock, 'native scroll debounce block must exist');
    assert.strictEqual(
        debounceBlock[0].includes('this._flushPendingMarquee()'),
        true,
        'Native scroll debounce (150ms) must flush deferred marquee checks'
    );
    const finishedBlock = source.match(/eventBus\.on\('scroll:finished', \(\) => \{[\s\S]*?\n        \}\);/);
    assert.ok(finishedBlock, 'scroll:finished listener must exist');
    assert.strictEqual(
        finishedBlock[0].includes('this._flushPendingMarquee()'),
        true,
        'scroll:finished listener must flush deferred marquee checks'
    );
});

test('ScrollController + CSS: scroll-active compositor budget gate wiring', () => {
    const source = readFileSync(new URL('../src/ui/ScrollController.js', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8');

    // 1. Axis tracking state is initialized in the constructor
    assert.strictEqual(
        source.includes('this._activeScrollAxes = new Set();'),
        true,
        '_activeScrollAxes must be initialized in the constructor'
    );

    // 2. The gate is engaged when the RAF scroll engine starts.
    //    Match the 8-space-indented engine start (the 16-space occurrence is
    //    the per-frame continuation inside the animate loop).
    const rafStartIdx = source.indexOf('\n        this[animIdKey] = requestAnimationFrame(animate);');
    assert.ok(rafStartIdx !== -1, 'RAF engine start must exist');
    const preRaf = source.slice(Math.max(0, rafStartIdx - 400), rafStartIdx);
    assert.strictEqual(
        preRaf.includes("this._beginScrollActivity(isVertical ? 'vertical' : 'horizontal')"),
        true,
        'RAF engine start must engage the scroll-active gate for the moving axis'
    );

    // 3. _checkScrollFinished recompute + DOM sync + scroll:finished emission
    const checkMatch = source.match(/_checkScrollFinished\(\) \{([\s\S]*?)\n    \}/);
    assert.ok(checkMatch, '_checkScrollFinished must be defined');
    const checkBody = checkMatch[1];
    assert.strictEqual(
        checkBody.includes('this._activeScrollAxes.delete'),
        true,
        '_checkScrollFinished must release finished axes'
    );
    assert.strictEqual(
        checkBody.includes('this._syncScrollActivityFlag()'),
        true,
        '_checkScrollFinished must sync the DOM gate attribute'
    );

    // 4. The DOM sync mirrors axes onto data-scroll-active and clears on settle
    assert.strictEqual(
        source.includes("root.setAttribute('data-scroll-active'"),
        true,
        'The gate must set <html data-scroll-active> while axes are active'
    );
    assert.strictEqual(
        source.includes("root.removeAttribute('data-scroll-active')"),
        true,
        'The gate must be removed at scroll-settle timing'
    );

    // 5. CSS gate: focus FX suppression + will-change demotion with track exception
    assert.strictEqual(
        css.includes('html[data-scroll-active] .media-card,'),
        true,
        'CSS must suppress card focus FX while scrolling'
    );
    assert.strictEqual(
        css.includes('html[data-scroll-active~="vertical"] *'),
        true,
        'CSS must demote stray will-change layers during vertical moves'
    );
    assert.strictEqual(
        css.includes('html[data-scroll-active~="vertical"] .vertical-scroll-track'),
        true,
        'CSS must preserve the promoted vertical scroll track during the gate'
    );
});
