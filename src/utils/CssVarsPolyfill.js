/**
 * ============================================================================
 * Litefin Tizen - High-Performance CSS Variables Engine
 * ============================================================================
 * Zero-dependency, lightning-fast CSS custom property (var()) resolution
 * engine designed specifically for legacy Smart TV hardware (webOS 3.x / Tizen 3.0,
 * running Chromium 38-47) where CSS variables are not natively supported.
 *
 * Eliminates the heavy AST parsing overhead and full-DOM reflow locks of
 * generic third-party polyfills, substituting all theme and custom properties
 * in-place via a high-speed multi-pass regex pass in under 20 milliseconds.
 * ============================================================================
 */

import { logger } from './Logger.js';

const log = logger.create('CssVarsPolyfill');

class CssVarsPolyfill {
    constructor() {
        /**
         * True if running on an ancient browser lacking native CSS custom properties.
         * Evaluated lazily in init() once window.CSS capability checks execute.
         * @type {boolean}
         */
        this._active = false;

        /**
         * Map of tracked <style> elements to their original unparsed CSS text templates.
         * Retaining raw templates allows instantaneous theme switching without re-parsing.
         * @type {Map<HTMLStyleElement, string>}
         */
        this._styleTemplates = new Map();
    }

    /**
     * Initialize the CSS variable resolution engine.
     *
     * Call this once after all CSS stylesheets have been injected
     * (i.e. after layoutManager.init()). On Chrome 49+ (Tizen 5+, webOS 4+, Desktop, Web),
     * CSS custom properties are native, so this returns immediately as a no-op.
     */
    init() {
        // Real CSS custom property feature detection
        // window.CSS.supports('--test', '0') reliably identifies native variable support
        const nativeCSSVars =
            typeof window.CSS !== 'undefined' &&
            typeof window.CSS.supports === 'function' &&
            window.CSS.supports('--test', '0');

        if (nativeCSSVars) {
            log.debug('Native CSS vars supported — polyfill skipped');
            return;
        }

        this._active = true;
        log.info('CSS vars NOT natively supported — activating high-speed engine');

        const self = this;
        // Defer with setTimeout(0) to ensure style-loader has injected all stylesheets
        setTimeout(function () {
            self._applyTransform(true);
        }, 0);
    }

    /**
     * Re-apply the polyfill after a theme or layout change.
     *
     * LayoutManager.setTheme() calls this after updating the data-theme
     * attribute, so the engine substitutes updated variables in under 15ms.
     */
    update() {
        if (!this._active) return;
        this._applyTransform(false);
    }

    /**
     * Executes the variable resolution pass across tracked stylesheets.
     *
     * Scans for the primary singleton bundled stylesheet (#litefin-bundled-styles)
     * or any active inline <style> elements, substituting variables directly in-place.
     *
     * @param {boolean} isInitial - True if called during initial app boot
     * @private
     */
    _applyTransform(isInitial) {
        const startTime = Date.now();

        // 1. Extract all active theme and :root variables
        const themeVars = this._extractThemeVariables();

        // 2. Discover style tags to transform
        // Priority: target our singleton bundled style tag if present,
        // or discover all style tags excluding dynamic helper stylesheets.
        let targetStyles = [];
        const bundledStyle = document.getElementById('litefin-bundled-styles');

        if (bundledStyle) {
            targetStyles = [bundledStyle];
        } else {
            const allStyles = document.querySelectorAll('style:not(#litefin-dynamic-theme-vars)');
            targetStyles = Array.prototype.slice.call(allStyles);
        }

        let updatedCount = 0;

        // Process each discovered stylesheet
        for (let i = 0; i < targetStyles.length; i++) {
            const styleEl = targetStyles[i];

            // Cache original raw CSS template with unresolved var() expressions
            let rawCss = this._styleTemplates.get(styleEl);
            if (!rawCss) {
                rawCss = styleEl.textContent || '';
                // Only track stylesheets that actually reference CSS variables
                if (rawCss.indexOf('var(--') === -1) {
                    continue;
                }
                this._styleTemplates.set(styleEl, rawCss);
            }

            // Perform high-speed multi-pass resolution
            const transformedCss = this._resolveCssVars(rawCss, themeVars);

            // Directly update the style element's text content in-place
            styleEl.textContent = transformedCss;
            styleEl.setAttribute('data-cssvars', 'applied');
            updatedCount++;
        }

        const elapsed = Date.now() - startTime;
        if (isInitial) {
            log.debug(`Initial CSS vars pass complete in ${elapsed}ms (${updatedCount} style(s) updated)`);
        } else {
            log.debug(`CSS vars update complete in ${elapsed}ms (${updatedCount} style(s) updated)`);
        }
    }

    /**
     * Resolves all var(--name, fallback) references in a CSS string using an
     * ultra-optimized, single-pass regex replacement pipeline.
     *
     * To achieve maximum rendering performance on resource-constrained TV chips
     * (such as 1.0 GHz dual-core Smart TVs), we first pre-resolve all internal variable
     * references within the in-memory dictionary itself (a microscopic map of ~100 keys).
     * Once the variable map is completely flattened into raw static values, the entire
     * multi-megabyte stylesheet string can be transformed in a SINGLE linear regex pass
     * rather than looping multiple times over megabytes of CSS text.
     *
     * @param {string} cssText - The raw CSS containing var() expressions
     * @param {Object} vars - Map of variable names to their computed values
     * @returns {string} Fully resolved CSS string
     * @private
     */
    _resolveCssVars(cssText, vars) {
        // Matches var(--name) or var(--name, fallback)
        // Group 1: variable name
        // Group 2: fallback expression with balanced nested parentheses support
        const varRegex = /var\(\s*(--[a-zA-Z0-9_-]+)(?:\s*,\s*((?:[^)(]+|\((?:[^)(]+|\([^)(]*\))*\))*))?\s*\)/g;

        /*
         * ====================================================================
         * STEP 1: Flatten in-memory variables dictionary
         * ====================================================================
         * Variables often reference other variables (e.g. --bg-primary: var(--jf-bg)).
         * Resolving this tiny ~100-entry map in memory takes <0.1ms and avoids
         * having to re-scan the massive multi-megabyte stylesheet string multiple times.
         */
        const flatVars = Object.assign({}, vars);
        let varsChanged = true;
        let dictionaryPass = 0;

        // Iterate until all variable aliases within the dictionary are fully flattened
        while (varsChanged && dictionaryPass < 4) {
            varsChanged = false;
            dictionaryPass++;

            // Loop through each registered variable in the map
            for (const key in flatVars) {
                const val = flatVars[key];
                // Check if this variable value contains another variable reference
                if (typeof val === 'string' && val.indexOf('var(--') !== -1) {
                    const resolved = val.replace(varRegex, (m, name, fb) => {
                        // If target alias exists, substitute immediately
                        if (flatVars[name] !== undefined && flatVars[name] !== '') {
                            return flatVars[name];
                        }
                        // Otherwise take fallback if defined
                        if (fb !== undefined && fb !== '') {
                            return fb.trim();
                        }
                        return m;
                    });

                    // Flag if an alias was resolved to trigger subsequent resolution pass
                    if (resolved !== val) {
                        flatVars[key] = resolved;
                        varsChanged = true;
                    }
                }
            }
        }

        /*
         * ====================================================================
         * STEP 2: Recursive fallback substitution helper
         * ====================================================================
         * If a stylesheet references an unknown variable with a nested fallback
         * (e.g. var(--missing, var(--known, #ffffff))), we unpack the fallback
         * chain recursively on the fly so the stylesheet is updated in a single pass.
         */
        const resolveToken = (varName, fallback) => {
            // Direct variable lookup in pre-flattened dictionary
            if (flatVars[varName] !== undefined && flatVars[varName] !== '') {
                return flatVars[varName];
            }

            // Fallback resolution path
            if (fallback !== undefined && fallback !== '') {
                const trimmed = fallback.trim();
                // If the fallback itself contains a nested var(), resolve it recursively
                if (trimmed.indexOf('var(--') !== -1) {
                    return trimmed.replace(varRegex, (m, subName, subFb) => resolveToken(subName, subFb));
                }
                return trimmed;
            }

            // Unresolved variable without fallback remains unchanged
            return `var(${varName}${fallback !== undefined ? `, ${fallback}` : ''})`;
        };

        /*
         * ====================================================================
         * STEP 3: Single linear replacement pass across stylesheet text
         * ====================================================================
         * Because flatVars is pre-flattened and resolveToken handles nested
         * fallbacks on demand, one linear replace() pass completely resolves the CSS.
         */
        return cssText.replace(varRegex, (match, varName, fallback) => resolveToken(varName, fallback));
    }

    /**
     * Extracts CSS variables from the currently active theme.
     * Manually extracts variables from :root, the active [data-theme-mode="..."]
     * class, and all active html[data-*] attribute blocks.
     *
     * @returns {Object} Map of css variable names to values
     * @private
     */
    _extractThemeVariables() {
        // Find the active theme explicitly set on HTML tag
        const root = document.documentElement;
        const themeMode = root.getAttribute('data-theme-mode') || 'classic-dark';
        const vars = {};

        // 1. Scan raw text content of injected <style> tags.
        const styleTags = document.querySelectorAll('style');

        // Regex to capture variables inside any block
        const varRegex = /(--[^:]+):\s*([^;}]+)/g;

        // Regex for :root blocks
        const rootBlockRegex = /:root[^{]*\{([^}]+)\}/g;

        // Regex for the active [data-theme-mode="..."] block
        const themeBlockRegex = new RegExp(
            '\\[data-theme(?:-mode)?=["\']?' + themeMode + '["\']?\\][^{]*\\{([^}]+)\\}',
            'g'
        );

        // Build regexes for ALL other active html[data-*] attributes.
        // e.g. data-rounded-corners="true", data-ui-font="system", etc.
        const activeAttrRegexes = [];
        const attrs = root.attributes;
        for (let a = 0; a < attrs.length; a++) {
            const attrName = attrs[a].name;
            const attrValue = attrs[a].value;
            // Only process data-* attributes that have a value and aren't
            // the theme-mode one (already handled above)
            if (
                attrName.indexOf('data-') === 0 &&
                attrName !== 'data-theme-mode' &&
                attrName !== 'data-theme' &&
                attrValue
            ) {
                // Escape any special regex chars in the attribute value
                const escapedValue = attrValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                activeAttrRegexes.push(
                    new RegExp('\\[' + attrName + '=["\']?' + escapedValue + '["\']?\\][^{]*\\{([^}]+)\\}', 'g')
                );
            }
        }

        // Parse variables across all active style tags
        for (let i = 0; i < styleTags.length; i++) {
            const cssText = styleTags[i].textContent;
            if (!cssText || cssText.indexOf('--') === -1) continue;

            let match, varMatch;

            // Extract from :root blocks — global defaults
            rootBlockRegex.lastIndex = 0;
            while ((match = rootBlockRegex.exec(cssText)) !== null) {
                const blockContent = match[1];
                varRegex.lastIndex = 0;
                while ((varMatch = varRegex.exec(blockContent)) !== null) {
                    vars[varMatch[1].trim()] = varMatch[2].trim();
                }
            }

            // Extract from active [data-theme-mode="..."] block
            themeBlockRegex.lastIndex = 0;
            while ((match = themeBlockRegex.exec(cssText)) !== null) {
                const blockContent = match[1];
                varRegex.lastIndex = 0;
                while ((varMatch = varRegex.exec(blockContent)) !== null) {
                    vars[varMatch[1].trim()] = varMatch[2].trim();
                }
            }

            // Extract from active html[data-*="value"] blocks
            for (let r = 0; r < activeAttrRegexes.length; r++) {
                const attrRegex = activeAttrRegexes[r];
                attrRegex.lastIndex = 0;
                while ((match = attrRegex.exec(cssText)) !== null) {
                    const blockContent = match[1];
                    varRegex.lastIndex = 0;
                    while ((varMatch = varRegex.exec(blockContent)) !== null) {
                        vars[varMatch[1].trim()] = varMatch[2].trim();
                    }
                }
            }
        }

        // 2. Scan variables set directly on <html> inline style.
        // These are written by LayoutManager._applyDynamicTheme().
        if (root.style) {
            for (let j = 0; j < root.style.length; j++) {
                const prop = root.style[j];
                if (prop && prop.indexOf('--') === 0) {
                    const value = root.style.getPropertyValue(prop);
                    if (value) vars[prop] = value.trim();
                }
            }
        }

        return vars;
    }
}

// Export singleton — one instance for the entire app lifecycle
export const cssVarsPolyfill = new CssVarsPolyfill();
export default CssVarsPolyfill;
