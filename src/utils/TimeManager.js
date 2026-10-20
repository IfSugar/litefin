/**
 * ============================================================================
 * Litefin - High-Precision Hybrid Time Manager
 * ============================================================================
 * Solves client-side time inaccuracy and desynchronization when Smart TVs
 * (Samsung Tizen, LG webOS) run in offline environments without internet access
 * (e.g. connected solely to a local Jellyfin server on LAN).
 *
 * Architecture:
 * 1. Samsung Tizen Driver: Queries native OS hardware clock via window.tizen.time.
 * 2. LG webOS Driver: Connects to Luna bus (time/getSystemTime) for live system time.
 * 3. Jellyfin Server Sync: NTP-style clock offset calculation (/GetUTCTime) using
 *    monotonic time (performance.now) as anchor to survive hardware RTC resets.
 * ============================================================================
 */

import { api } from '../api/index.js';
import { eventBus } from '../core/EventBus.js';
import { logger } from './Logger.js';
import { PlayerSettings } from './PlayerSettings.js';

const log = logger.create('TimeManager');

// Interval between automatic Jellyfin server time synchronization polls (15 minutes)
const SYNC_INTERVAL_MS = 15 * 60 * 1000;

class TimeManager {
    constructor() {
        // Platform detection flags
        this._isTizen = false;
        this._isWebOS = false;

        // WebOS system time cache and active subscription bridge
        this._webosTime = null;
        this._webosSubscription = null;

        // Server anchor for monotonic high-resolution calculation
        // Structure: { serverEpochMs: number, perfMs: number, offsetMs: number }
        this._serverAnchor = null;
        this._isServerSynced = false;

        // Background polling handle
        this._syncTimer = null;
        this._isSyncing = false;
        this._lastLoggedMinute = null;
    }

    /**
     * Initializes the TimeManager, detecting platform drivers and establishing
     * native OS clock listeners and server sync hooks.
     */
    init() {
        log.info('Initializing TimeManager subsystem...');

        // --------------------------------------------------------------------
        // 1. Identify Host Operating Environment
        // --------------------------------------------------------------------
        const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
        this._isTizen = typeof window !== 'undefined' && Boolean(window.tizen && window.tizen.time);
        this._isWebOS = /Web[O0]S|NetCast|LG[ -]Browser/i.test(ua) || (typeof window !== 'undefined' && Boolean(window.webOS));

        log.info(`Platform clock drivers detected — Tizen: ${this._isTizen}, WebOS: ${this._isWebOS}`);

        // --------------------------------------------------------------------
        // 1.1. Diagnostic Probe: Print OS Date on Startup
        // --------------------------------------------------------------------
        if (this._isTizen && window.tizen?.time?.getCurrentDateTime) {
            try {
                const tz = window.tizen.time.getCurrentDateTime();
                log.info(`[TimeManager] Tizen startup OS clock probe — toLocaleString: "${tz.toLocaleString()}", timezone: "${tz.getTimezone()}", offset: ${tz.getTimezoneOffset()}, raw:`, {
                    year: tz.getFullYear(),
                    month: tz.getMonth(),
                    date: tz.getDate(),
                    hours: tz.getHours(),
                    minutes: tz.getMinutes(),
                    seconds: tz.getSeconds()
                });
            } catch (err) {
                log.warn('[TimeManager] Tizen startup clock probe failed:', err);
            }
        }

        // --------------------------------------------------------------------
        // 2. Initialize Platform-Specific Native Drivers
        // --------------------------------------------------------------------
        if (this._isWebOS) {
            this._initWebOSClockDriver();
        }

        // --------------------------------------------------------------------
        // 3. Register Event Bus Hooks for Server Time Synchronization
        // --------------------------------------------------------------------
        // Trigger clock alignment whenever server connectivity is confirmed
        if (typeof eventBus !== 'undefined' && typeof eventBus.on === 'function') {
            eventBus.on('auth:success', () => {
                log.debug('Authentication confirmed, initiating server time sync...');
                this.syncServerTime();
            });

            eventBus.on('api:ready', () => {
                this.syncServerTime();
            });

            eventBus.on('network:online', () => {
                this.syncServerTime();
            });

            eventBus.on('pref:timeSource', (newSource) => {
                log.info(`Time source preference changed to: ${newSource}`);
                if (newSource === 'server') {
                    this.syncServerTime();
                } else if (newSource === 'os') {
                    if (this._isTizen && window.tizen?.time?.getCurrentDateTime) {
                        try {
                            const tz = window.tizen.time.getCurrentDateTime();
                            log.info(`[TimeManager] Tizen OS date on switch: toLocaleString="${tz.toLocaleString()}", timezone="${tz.getTimezone()}", raw=${tz.getFullYear()}-${tz.getMonth() + 1}-${tz.getDate()} ${tz.getHours()}:${tz.getMinutes()}:${tz.getSeconds()}`);
                        } catch (e) {
                            log.warn('[TimeManager] Tizen OS switch probe error:', e);
                        }
                    } else if (this._isWebOS) {
                        this._initWebOSClockDriver();
                    }
                }
            });
        }

        // --------------------------------------------------------------------
        // 4. Initial Server Sync Attempt & Periodic Recalibration
        // --------------------------------------------------------------------
        this.syncServerTime();

        if (this._syncTimer) {
            clearInterval(this._syncTimer);
        }
        this._syncTimer = setInterval(() => {
            this.syncServerTime();
        }, SYNC_INTERVAL_MS);

        log.info('TimeManager successfully initialized');
    }

    /**
     * Connects to LG webOS Luna System Service to receive authoritative OS wall-clock time
     * and subscribe to live time/timezone updates configured by the user in TV menus.
     * @private
     */
    _initWebOSClockDriver() {
        try {
            const requestMethod = 'time/getSystemTime';
            const requestParams = { subscribe: true };

            const handleResponse = (response) => {
                if (!response) return;

                // Typical response contains localtime: { year, month, day, hour, minute, second }
                // and utc timestamp + timezone offset
                log.info('Received native time from webOS system service:', response);

                if (response.localtime) {
                    this._webosTime = {
                        year: response.localtime.year,
                        month: response.localtime.month, // Note: 1-indexed (1-12)
                        day: response.localtime.day,
                        hour: response.localtime.hour,
                        minute: response.localtime.minute,
                        second: response.localtime.second,
                        offsetMinutes: typeof response.offset === 'number' ? response.offset : null,
                        perfMs: performance.now()
                    };
                }
            };

            // Attempt standard webOS service bus invocation
            if (window.webOS && window.webOS.service && typeof window.webOS.service.request === 'function') {
                this._webosSubscription = window.webOS.service.request('luna://com.palm.systemservice', {
                    method: requestMethod,
                    parameters: requestParams,
                    subscribe: true,
                    onSuccess: handleResponse,
                    onFailure: (err) => {
                        log.warn('Primary com.palm.systemservice call failed, attempting com.webos fallback:', err);
                        // Fallback for modern webOS OSE / newer firmware releases
                        this._tryWebOSFallbackService(handleResponse);
                    }
                });
            } else if (typeof window.PalmServiceBridge !== 'undefined') {
                // Direct PalmServiceBridge for legacy/bare environments
                const bridge = new window.PalmServiceBridge();
                bridge.onservicecallback = (msg) => {
                    try {
                        const parsed = JSON.parse(msg);
                        handleResponse(parsed);
                    } catch (err) {
                        log.warn('Failed parsing PalmServiceBridge response:', err);
                    }
                };
                bridge.call('luna://com.palm.systemservice/' + requestMethod, JSON.stringify(requestParams));
                this._webosSubscription = bridge;
            }
        } catch (error) {
            log.warn('Exception during webOS clock driver initialization:', error);
        }
    }

    /**
     * Fallback driver for newer webOS revisions utilizing com.webos.service.systemservice.
     * @private
     * @param {Function} handleResponse
     */
    _tryWebOSFallbackService(handleResponse) {
        try {
            if (window.webOS && window.webOS.service) {
                window.webOS.service.request('luna://com.webos.service.systemservice', {
                    method: 'time/getSystemTime',
                    parameters: { subscribe: true },
                    subscribe: true,
                    onSuccess: handleResponse,
                    onFailure: (err) => {
                        log.warn('All webOS system time service calls failed:', err);
                    }
                });
            }
        } catch (e) {
            log.warn('Fallback webOS system service exception:', e);
        }
    }

    /**
     * Synchronizes local high-precision clock against the connected Jellyfin server.
     * Uses NTP-style calculation over /GetUTCTime to derive network delay and offset.
     * @returns {Promise<boolean>}
     */
    async syncServerTime() {
        if (this._isSyncing) return false;
        if (!api || typeof api.getServerTime !== 'function') return false;

        this._isSyncing = true;
        const t0 = Date.now();

        try {
            // GET /GetUTCTime returns RequestReceptionTime and ResponseTransmissionTime
            const response = await api.getServerTime();
            const t3 = Date.now();

            let receptionMs = Date.parse(response?.RequestReceptionTime);
            let transmissionMs = Date.parse(response?.ResponseTransmissionTime);

            // Handle servers returning a single timestamp string or alternative field
            if (isNaN(receptionMs) || isNaN(transmissionMs)) {
                if (typeof response === 'string') {
                    const parsed = Date.parse(response);
                    if (!isNaN(parsed)) {
                        receptionMs = parsed;
                        transmissionMs = parsed;
                    }
                } else if (response && typeof response === 'object') {
                    const candidate = response.ServerTime || response.Time || response.DateTime || response.UtcTime;
                    if (candidate) {
                        const parsed = Date.parse(candidate);
                        if (!isNaN(parsed)) {
                            receptionMs = parsed;
                            transmissionMs = parsed;
                        }
                    }
                }
            }

            if (!isNaN(receptionMs) && !isNaN(transmissionMs)) {
                // Classic NTP delay and clock offset computation
                const roundTrip = t3 - t0;
                const serverProcessing = transmissionMs - receptionMs;
                const networkDelay = Math.max(0, (roundTrip - serverProcessing) / 2);
                const estimatedServerEpoch = transmissionMs + networkDelay;

                // Anchor server time against high-resolution monotonic timer
                this._serverAnchor = {
                    serverEpochMs: estimatedServerEpoch,
                    perfMs: performance.now(),
                    offsetMs: estimatedServerEpoch - t3
                };
                this._isServerSynced = true;

                log.info(
                    `Server time synchronized — offset: ${this._serverAnchor.offsetMs}ms, ` +
                    `rtt: ${roundTrip}ms, delay: ${networkDelay.toFixed(1)}ms`
                );

                // Notify all live clock displays (GlobalClock, MobileNav, OSD) to immediately re-render
                if (typeof eventBus !== 'undefined' && typeof eventBus.emit === 'function') {
                    eventBus.emit('time:synced');
                }
                return true;
            } else {
                log.debug('Server response did not contain parseable timestamps:', response);
            }
        } catch (error) {
            log.debug('Server time synchronization skipped/failed:', error?.message || error);
        } finally {
            this._isSyncing = false;
        }

        return false;
    }

    /**
     * Returns a valid JavaScript Date object reflecting current local time
     * according to the user's selected timeSource preference:
     * - 'browser': Standard host environment Date (Default)
     * - 'os': Native TV OS hardware/system clock (Tizen / webOS)
     * - 'server': Jellyfin Server time sync via /GetUTCTime + performance.now anchor
     *
     * @returns {Date}
     */
    now() {
        // Retrieve user preference, defaulting strictly to 'browser'
        const source = (typeof PlayerSettings !== 'undefined' && PlayerSettings.get('timeSource')) || 'browser';

        // --------------------------------------------------------------------
        // Strategy: Native Device Operating System (Tizen / webOS)
        // --------------------------------------------------------------------
        if (source === 'os') {
            // 1. Samsung Tizen Native Device Time
            if (this._isTizen && window.tizen?.time?.getCurrentDateTime) {
                try {
                    const tz = window.tizen.time.getCurrentDateTime();
                    if (tz && typeof tz.getFullYear === 'function') {
                        // Diagnostic log: throttled to once per minute or on initial read
                        const minuteKey = `${tz.getFullYear()}-${tz.getMonth()}-${tz.getDate()} ${tz.getHours()}:${tz.getMinutes()}`;
                        if (this._lastLoggedMinute !== minuteKey) {
                            this._lastLoggedMinute = minuteKey;
                            log.info(`[TimeManager] Tizen OS active date: "${tz.toLocaleString()}" (tz: ${tz.getTimezone()}, offset: ${tz.getTimezoneOffset()}, year: ${tz.getFullYear()}, hours: ${tz.getHours()}:${tz.getMinutes()}:${tz.getSeconds()})`);
                        }

                        return new Date(
                            tz.getFullYear(),
                            tz.getMonth(),
                            tz.getDate(),
                            tz.getHours(),
                            tz.getMinutes(),
                            tz.getSeconds(),
                            tz.getMilliseconds()
                        );
                    }
                } catch (err) {
                    log.warn('Tizen native time reading failed:', err);
                }
            }

            // 2. LG webOS Native System Service Time
            if (this._isWebOS && this._webosTime) {
                try {
                    const elapsedMs = performance.now() - this._webosTime.perfMs;
                    const baseLocalMs = new Date(
                        this._webosTime.year,
                        this._webosTime.month - 1, // Convert 1-indexed month to 0-indexed JS month
                        this._webosTime.day,
                        this._webosTime.hour,
                        this._webosTime.minute,
                        this._webosTime.second
                    ).getTime();

                    return new Date(baseLocalMs + elapsedMs);
                } catch (err) {
                    log.warn('WebOS native time calculation failed:', err);
                }
            }

            // Fallback to browser date if native OS bridge is unavailable on this platform
            return new Date();
        }

        // --------------------------------------------------------------------
        // Strategy: Jellyfin Server Monotonic Anchor
        // --------------------------------------------------------------------
        if (source === 'server') {
            if (this._isServerSynced && this._serverAnchor) {
                try {
                    // Elapsed high-resolution monotonic time since the last server sync
                    const elapsed = performance.now() - this._serverAnchor.perfMs;
                    const serverUtcEpoch = this._serverAnchor.serverEpochMs + elapsed;

                    // Browser environment local timezone offset in minutes (e.g. -180 for UTC+3)
                    const browserOffset = new Date().getTimezoneOffset();
                    let targetTzOffset = null;

                    // Check if Tizen provides native timezone configuration
                    if (window.tizen?.time?.getCurrentDateTime) {
                        try {
                            const tz = window.tizen.time.getCurrentDateTime();
                            if (tz && typeof tz.getTimezoneOffset === 'function') {
                                targetTzOffset = tz.getTimezoneOffset();
                            }
                        } catch (_) { }
                    }

                    // Check if webOS reported a native timezone offset
                    if (targetTzOffset === null && this._webosTime && typeof this._webosTime.offsetMinutes === 'number') {
                        // webOS offset is minutes East of GMT (e.g. +180 for UTC+3),
                        // whereas JS getTimezoneOffset() is minutes West of GMT (e.g. -180 for UTC+3)
                        targetTzOffset = -this._webosTime.offsetMinutes;
                    }

                    // If native platform didn't specify an offset, default to browser's own timezone offset
                    if (targetTzOffset === null) {
                        targetTzOffset = browserOffset;
                    }

                    // Standard new Date(serverUtcEpoch) already applies the browser's local timezone
                    // when getHours()/getMinutes() are invoked.
                    // We only apply runtimeGapMs if the host webview runtime is stuck in UTC (browserOffset = 0)
                    // while the TV OS is configured for a specific timezone (targetTzOffset != 0).
                    const runtimeGapMs = (browserOffset - targetTzOffset) * 60 * 1000;

                    return new Date(serverUtcEpoch + runtimeGapMs);
                } catch (err) {
                    log.warn('Server anchor calculation failed:', err);
                }
            }

            // Fallback to standard browser date if server sync is still pending
            return new Date();
        }

        // --------------------------------------------------------------------
        // Strategy: Standard Browser JavaScript Engine (Default: 'browser')
        // --------------------------------------------------------------------
        return new Date();
    }

    /**
     * Convenient helper returning the current epoch millisecond timestamp.
     * @returns {number}
     */
    getTime() {
        return this.now().getTime();
    }
}

// Export singleton instance
export const timeManager = new TimeManager();
export default timeManager;
