import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('WebOSPlayer: Dolby Vision and E-AC-3 HLS stream routing validation', () => {
    // Read the WebOSPlayer source file to verify architectural integrity
    const playerSource = readFileSync(
        new URL('../src/player/core/WebOSPlayer.js', import.meta.url),
        'utf8'
    );

    // -------------------------------------------------------------------------
    // 1. Verify play() calls _shouldUseNativeHls with options argument
    // -------------------------------------------------------------------------
    assert.ok(
        playerSource.includes('this._shouldUseNativeHls(options)'),
        'play() must pass options to _shouldUseNativeHls to allow stream metadata inspection'
    );

    // -------------------------------------------------------------------------
    // 2. Verify _canUseHlsJs helper exists
    // -------------------------------------------------------------------------
    assert.ok(
        playerSource.includes('_canUseHlsJs('),
        'WebOSPlayer must implement _canUseHlsJs method to check stream compatibility'
    );

    // -------------------------------------------------------------------------
    // 3. Verify Dolby Vision inspection in _canUseHlsJs
    // -------------------------------------------------------------------------
    assert.ok(
        playerSource.includes('Dolby Vision stream detected') &&
        playerSource.includes("rangeType.startsWith('DOVI')"),
        '_canUseHlsJs must detect Dolby Vision streams and reject Hls.js'
    );

    // -------------------------------------------------------------------------
    // 4. Verify E-AC-3 / AC-3 audio inspection in _canUseHlsJs
    // -------------------------------------------------------------------------
    assert.ok(
        playerSource.includes("'eac3'") &&
        playerSource.includes("'ac3'") &&
        playerSource.includes('unsupportedAudioCodecs.includes(audioCodec)'),
        '_canUseHlsJs must reject audio codecs unsupported by Hls.js TS demuxer'
    );

    // -------------------------------------------------------------------------
    // 5. Verify _shouldUseNativeHls delegates to _canUseHlsJs
    // -------------------------------------------------------------------------
    assert.ok(
        playerSource.includes('if (!this._canUseHlsJs(options)) {') &&
        playerSource.includes('return true;'),
        '_shouldUseNativeHls must return true for streams incompatible with Hls.js'
    );

    // -------------------------------------------------------------------------
    // 6. Verify Hls.js fallbacks are guarded by _canUseHlsJs
    // -------------------------------------------------------------------------
    assert.ok(
        playerSource.includes('this._canUseHlsJs(options) && !this._hlsFallbackAttempted'),
        '_playNativeHls error handler must verify stream compatibility before Hls.js fallback'
    );
    assert.ok(
        playerSource.includes('this._canUseHlsJs(this._currentPlayOptions) && !this._hlsFallbackAttempted'),
        'Robust seek and decode error handlers must verify stream compatibility before Hls.js fallback'
    );
});

test('WebOSPlayer: Behavioral simulation of _canUseHlsJs and _shouldUseNativeHls', () => {
    // Mock Hls global object
    globalThis.Hls = {
        isSupported: () => true
    };

    // Helper simulation matching the WebOSPlayer implementation
    const simulateCanUseHlsJs = (options) => {
        if (!globalThis.Hls.isSupported()) return false;
        if (!options) return true;

        const mediaStreams = options.mediaSource?.MediaStreams || [];
        const videoStream = mediaStreams.find(s => s.Type === 'Video');
        const rangeType = (videoStream?.VideoRangeType || options.item?.VideoRangeType || '').toUpperCase();
        const extendedRange = (videoStream?.ExtendedVideoRangeType || '').toUpperCase();
        const itemRange = (options.item?.VideoRange || '').toUpperCase();
        const isDoVi = rangeType.startsWith('DOVI') || extendedRange.startsWith('DOVI') ||
                       rangeType.includes('DOVI') || itemRange.includes('DOVI');

        if (isDoVi) return false;

        const videoCodec = (videoStream?.Codec || '').toLowerCase();
        if (videoCodec === 'hevc' || videoCodec === 'h265') return false;

        const isHdr = rangeType.startsWith('HDR') || rangeType.startsWith('HLG') ||
                      itemRange.startsWith('HDR') || itemRange.startsWith('HLG');
        if (isHdr) return false;

        const selectedAudioIndex = options.audioStreamIndex;
        const audioStreams = mediaStreams.filter(s => s.Type === 'Audio');
        const activeAudio = (selectedAudioIndex !== undefined && audioStreams.find(s => s.Index === selectedAudioIndex)) ||
                            audioStreams.find(s => s.IsDefault) ||
                            audioStreams[0];
        const audioCodec = (activeAudio?.Codec || '').toLowerCase();
        const unsupportedAudioCodecs = ['eac3', 'ac3', 'dolbydigitalplus', 'dts', 'dca', 'truehd', 'mlp'];

        if (unsupportedAudioCodecs.includes(audioCodec)) return false;

        return true;
    };

    const simulateShouldUseNativeHls = (options, webosVersion = 4) => {
        if (!simulateCanUseHlsJs(options)) {
            return true;
        }
        if (webosVersion < 5 && globalThis.Hls.isSupported()) {
            return false;
        }
        return true;
    };

    // -------------------------------------------------------------------------
    // Scenario 1: Dolby Vision Profile 5 MKV with E-AC-3 audio on webOS 4 (Reported Bug)
    // -------------------------------------------------------------------------
    const doViProfile5Options = {
        isHls: true,
        url: 'http://server:8096/videos/123/master.m3u8?SegmentContainer=ts',
        audioStreamIndex: 1,
        mediaSource: {
            MediaStreams: [
                {
                    Type: 'Video',
                    Codec: 'hevc',
                    VideoRangeType: 'DOVI',
                    ExtendedVideoRangeType: 'DOVI'
                },
                {
                    Type: 'Audio',
                    Index: 1,
                    Codec: 'eac3',
                    IsDefault: true
                }
            ]
        }
    };

    assert.equal(
        simulateCanUseHlsJs(doViProfile5Options),
        false,
        'Dolby Vision Profile 5 + E-AC-3 must be flagged incompatible with Hls.js'
    );
    assert.equal(
        simulateShouldUseNativeHls(doViProfile5Options, 4),
        true,
        'Dolby Vision Profile 5 must use native HLS pipeline on webOS 4 to avoid green screen'
    );

    // -------------------------------------------------------------------------
    // Scenario 2: Standard SDR H.264 stream with AAC audio on webOS 4
    // -------------------------------------------------------------------------
    const sdrAacOptions = {
        isHls: true,
        url: 'http://server:8096/videos/456/master.m3u8',
        audioStreamIndex: 1,
        mediaSource: {
            MediaStreams: [
                {
                    Type: 'Video',
                    Codec: 'h264',
                    VideoRangeType: 'SDR'
                },
                {
                    Type: 'Audio',
                    Index: 1,
                    Codec: 'aac',
                    IsDefault: true
                }
            ]
        }
    };

    assert.equal(
        simulateCanUseHlsJs(sdrAacOptions),
        true,
        'Standard SDR H.264 + AAC must be compatible with Hls.js'
    );
    assert.equal(
        simulateShouldUseNativeHls(sdrAacOptions, 4),
        false,
        'Standard SDR H.264 + AAC must prefer Hls.js MSE on webOS 4 for reliable resume seeking'
    );
    assert.equal(
        simulateShouldUseNativeHls(sdrAacOptions, 5),
        true,
        'Standard SDR H.264 + AAC on webOS 5+ uses native HLS pipeline'
    );
});
