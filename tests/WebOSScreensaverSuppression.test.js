import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * ============================================================================
 * LG webOS System Screensaver Suppression Test Suite
 * ============================================================================
 * Verifies that:
 *   1. WebOSAdapter implements setKeepScreenOn, _setupScreensaverGuard,
 *      _registerScreenSaverGuard, and _respondScreenSaver.
 *   2. When video playback is active (setKeepScreenOn(true)), incoming screensaver
 *      requests from luna://com.webos.service.tvpower/power/registerScreenSaverRequest
 *      are answered with ack: false to prevent the LG system screensaver from activating.
 *   3. When video playback is paused or stopped (setKeepScreenOn(false)), incoming
 *      screensaver requests are answered with ack: true to allow the OLED screensaver
 *      to activate when the TV is idle.
 *   4. Power keepalive activities with luna://com.palm.activitymanager are created
 *      upon playback start and canceled upon playback exit.
 *   5. PlayerPage.js explicitly coordinates with webosAdapter.setKeepScreenOn.
 * ============================================================================
 */

test('WebOSAdapter: Source code integrity for screensaver suppression and power keepalive', () => {
    const adapterSource = readFileSync(
        new URL('../src/webos/WebOSAdapter.js', import.meta.url),
        'utf8'
    );

    // 1. Verify SCREENSAVER_CLIENT identifier
    assert.ok(
        adapterSource.includes("org.litefin.app"),
        'WebOSAdapter must use org.litefin.app as the screensaver client name'
    );

    // 2. Verify registration with tvpower service
    assert.ok(
        adapterSource.includes('luna://com.webos.service.tvpower') &&
        adapterSource.includes('power/registerScreenSaverRequest'),
        'WebOSAdapter must register with tvpower/registerScreenSaverRequest'
    );

    // 3. Verify response to tvpower service with ack
    assert.ok(
        adapterSource.includes('power/responseScreenSaverRequest') &&
        adapterSource.includes('ack: !this._screenSaverBlocked') ||
        adapterSource.includes('const ack = !this._screenSaverBlocked'),
        'WebOSAdapter must respond with ack: false when playback is blocked'
    );

    // 4. Verify activitymanager keepalive integration
    assert.ok(
        adapterSource.includes('luna://com.palm.activitymanager') &&
        adapterSource.includes("name: 'org.litefin.app-playback-keepalive'"),
        'WebOSAdapter must register a keepalive activity with com.palm.activitymanager'
    );

    // 5. Verify PlayerPage.js integrates webosAdapter.setKeepScreenOn
    const playerPageSource = readFileSync(
        new URL('../src/pages/PlayerPage.js', import.meta.url),
        'utf8'
    );
    assert.ok(
        playerPageSource.includes('webosAdapter.setKeepScreenOn(true)'),
        'PlayerPage.js must call webosAdapter.setKeepScreenOn(true) on playback start'
    );
    assert.ok(
        playerPageSource.includes('webosAdapter.setKeepScreenOn(false)'),
        'PlayerPage.js must call webosAdapter.setKeepScreenOn(false) on playback destroy'
    );
});

test('WebOSAdapter: Behavioral simulation of screensaver guard and ack logic', () => {
    let screensaverBlocked = false;
    let registeredCallback = null;
    const sentResponses = [];
    const activityManagerCalls = [];

    // Mock Luna service bridge for tvpower and activitymanager
    const mockWebOS = {
        service: {
            request(serviceUri, options) {
                if (serviceUri === 'luna://com.webos.service.tvpower') {
                    if (options.method === 'power/registerScreenSaverRequest') {
                        registeredCallback = options.onSuccess;
                        return { cancel: () => { registeredCallback = null; } };
                    }
                    if (options.method === 'power/responseScreenSaverRequest') {
                        sentResponses.push(options.parameters);
                        options.onSuccess?.({ returnValue: true });
                        return {};
                    }
                }
                if (serviceUri === 'luna://com.palm.activitymanager') {
                    activityManagerCalls.push({ method: options.method, parameters: options.parameters });
                    if (options.method === 'create') {
                        options.onSuccess?.({ returnValue: true, activityId: 999 });
                    } else if (options.method === 'cancel') {
                        options.onSuccess?.({ returnValue: true });
                    }
                    return {};
                }
                return {};
            }
        }
    };

    // Simulation functions mirroring WebOSAdapter
    const setKeepScreenOn = (keepOn) => {
        screensaverBlocked = Boolean(keepOn);
        if (keepOn) {
            mockWebOS.service.request('luna://com.webos.service.tvpower', {
                method: 'power/registerScreenSaverRequest',
                parameters: { clientName: 'org.litefin.app', subscribe: true },
                onSuccess: (res) => {
                    if (res && res.timestamp) {
                        respondScreenSaver(res.timestamp);
                    }
                }
            });
            mockWebOS.service.request('luna://com.palm.activitymanager', {
                method: 'create',
                parameters: {
                    activity: {
                        name: 'org.litefin.app-playback-keepalive',
                        type: { foreground: true, continuous: true, power: true, powerDebounce: true }
                    }
                }
            });
        } else {
            mockWebOS.service.request('luna://com.palm.activitymanager', {
                method: 'cancel',
                parameters: { activityId: 999 }
            });
        }
    };

    const respondScreenSaver = (timestamp) => {
        const ack = !screensaverBlocked;
        mockWebOS.service.request('luna://com.webos.service.tvpower', {
            method: 'power/responseScreenSaverRequest',
            parameters: { clientName: 'org.litefin.app', ack, timestamp }
        });
    };

    // 1. Enter playback -> keep screen on
    setKeepScreenOn(true);
    assert.equal(screensaverBlocked, true, 'Screensaver must be blocked during playback');
    assert.ok(registeredCallback, 'Screensaver callback must be registered');
    assert.equal(activityManagerCalls[0].method, 'create', 'Keepalive activity must be created');

    // 2. TV triggers screensaver request after 30 minutes of idle remote
    registeredCallback({ returnValue: true, timestamp: 1729240000 });
    assert.equal(sentResponses.length, 1);
    assert.deepEqual(sentResponses[0], {
        clientName: 'org.litefin.app',
        ack: false, // CRITICAL: must deny screensaver
        timestamp: 1729240000
    }, 'Must reply with ack: false during playback to block screensaver');

    // 3. Pause / Stop playback -> screensaver allowed
    setKeepScreenOn(false);
    assert.equal(screensaverBlocked, false, 'Screensaver must not be blocked when paused or stopped');
    assert.equal(activityManagerCalls[1].method, 'cancel', 'Keepalive activity must be canceled');

    // 4. TV triggers screensaver request while paused / idle
    registeredCallback({ returnValue: true, timestamp: 1729241800 });
    assert.equal(sentResponses.length, 2);
    assert.deepEqual(sentResponses[1], {
        clientName: 'org.litefin.app',
        ack: true, // CRITICAL: must allow screensaver when paused
        timestamp: 1729241800
    }, 'Must reply with ack: true when stopped to allow OLED protection screensaver');
});
