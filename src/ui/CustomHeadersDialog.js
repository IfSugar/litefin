/**
 * ============================================================================
 * Litefin - CustomHeadersDialog
 * ============================================================================
 * Lightweight modal dialog for configuring reverse proxy HTTP authentication
 * headers (Cloudflare Zero Trust / Access, Pangolin, Authelia, Traefik, etc.).
 *
 * Optimized specifically for low-spec Smart TV runtimes:
 *   - Zero backdrop-filter blur effects to prevent GPU/compositor stalls.
 *   - Zero box-shadows for fast hardware rasterization.
 *   - Flat, solid high-contrast backgrounds with clear focus rings.
 *   - Spatial navigation lock via FocusManager trap enforcement.
 *   - Quick-preset insertion for Cloudflare and Pangolin tokens.
 * ============================================================================
 */

import { focusManager } from './FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { customHeaders, HEADER_PRESETS } from '../utils/CustomHeaders.js';
import { logger } from '../utils/Logger.js';
import { escapeHtml } from '../utils/Utils.js';

const log = logger.create('CustomHeadersDialog');

class CustomHeadersDialog {
    constructor() {
        this.isVisible = false;
        this.overlay = null;
        this._serverUrl = '';
        this._headers = [];
        this._onSave = null;
        this._onCancel = null;
    }

    /**
     * Opens the Custom Headers configuration dialog.
     *
     * @param {Object} options
     * @param {string} options.serverUrl - Target server address
     * @param {Array<Object>} [options.existingHeaders] - Pre-populated header items
     * @param {Function} [options.onSave] - Callback executed with saved headers
     * @param {Function} [options.onCancel] - Callback executed on dismissal
     */
    show(options = {}) {
        if (this.isVisible) return;
        this.isVisible = true;

        this._serverUrl = options.serverUrl || '';
        this._onSave = options.onSave || null;
        this._onCancel = options.onCancel || null;

        // Clone existing headers or load stored headers for this server address
        if (Array.isArray(options.existingHeaders) && options.existingHeaders.length > 0) {
            this._headers = JSON.parse(JSON.stringify(options.existingHeaders));
        } else if (this._serverUrl) {
            const stored = customHeaders.getServerHeaders(this._serverUrl);
            this._headers = JSON.parse(JSON.stringify(stored));
        } else {
            this._headers = [];
        }

        // Build DOM structure
        this.overlay = document.createElement('div');
        this.overlay.id = 'custom-headers-dialog-overlay';
        this.overlay.className = 'modal-overlay visible custom-headers-overlay';
        document.body.appendChild(this.overlay);

        this._renderDialog();
    }

    /**
     * Renders or re-renders the dialog template and binds focus traps.
     * @private
     */
    _renderDialog() {
        if (!this.overlay) return;

        const serverLabel = this._serverUrl ? escapeHtml(this._serverUrl) : (i18n.t('CurrentServer') || 'Current Server');

        this.overlay.innerHTML = `
            <div class="settings-modal custom-headers-modal" role="dialog" aria-modal="true" aria-label="Custom HTTP Headers">
                <div class="modal-header">
                    <h2>${i18n.t('CustomHttpHeadersTitle') || 'Custom HTTP Headers'}</h2>
                    <p class="modal-subtitle" style="font-size: 0.95rem; color: #a0a0a8; margin: 4px 0 0 0;">
                        ${i18n.t('CustomHttpHeadersSubtitle') || 'Configure proxy gateway headers for'} <strong>${serverLabel}</strong>
                    </p>
                </div>

                <!-- Presets Quick Bar -->
                <div class="custom-headers-presets-bar" id="custom-headers-presets-bar" style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px;">
                    <button type="button" class="btn btn-secondary modal-action-btn" id="preset-cf-btn" tabindex="0">
                        + Cloudflare Zero Trust
                    </button>
                    <button type="button" class="btn btn-secondary modal-action-btn" id="preset-pangolin-btn" tabindex="0">
                        + Pangolin
                    </button>
                    <button type="button" class="btn btn-secondary modal-action-btn" id="add-header-btn" tabindex="0">
                        + ${i18n.t('AddCustomHeader') || 'Add Header'}
                    </button>
                </div>

                <!-- Headers List Container -->
                <div class="modal-content custom-headers-content" id="custom-headers-list-container" style="max-height: 52vh; overflow-y: auto; padding: 4px 0;">
                    ${this._renderHeadersList()}
                </div>

                <!-- Action Buttons -->
                <div class="modal-actions" id="custom-headers-actions" style="margin-top: 16px; display: flex; justify-content: flex-end; gap: 12px;">
                    <button type="button" class="btn btn-secondary modal-action-btn" id="custom-headers-cancel-btn" tabindex="0">
                        ${i18n.t('ButtonCancel') || 'Cancel'}
                    </button>
                    <button type="button" class="btn btn-primary modal-action-btn" id="custom-headers-save-btn" tabindex="0">
                        ${i18n.t('Save') || 'Save'}
                    </button>
                </div>
            </div>
        `;

        this._bindEvents();
        this._updateFocusTrap();
    }

    /**
     * Generates HTML markup for the configured header rows.
     * @private
     * @returns {string} HTML string
     */
    _renderHeadersList() {
        if (!this._headers || this._headers.length === 0) {
            return `
                <div class="custom-headers-empty" style="padding: 24px 12px; text-align: center; color: #888892; font-size: 1rem;">
                    ${i18n.t('NoCustomHeadersConfigured') || 'No custom headers configured. Use a preset above or click Add Header to start.'}
                </div>
            `;
        }

        return this._headers.map((item, index) => {
            const keyVal = escapeHtml(item.key || '');
            const valVal = escapeHtml(item.value || '');
            const isEnabled = item.enabled !== false;
            const toggleText = isEnabled ? (i18n.t('Enabled') || 'Enabled') : (i18n.t('Disabled') || 'Disabled');
            const toggleClass = isEnabled ? 'btn-toggle-active' : 'btn-toggle-inactive';

            return `
                <div class="custom-header-row" data-index="${index}" style="display: flex; gap: 8px; align-items: center; margin-bottom: 10px;">
                    <input
                        type="text"
                        class="text-input tv-input custom-header-key"
                        placeholder="Header Name"
                        value="${keyVal}"
                        data-index="${index}"
                        style="flex: 2; padding: 10px 14px; font-size: 0.95rem; background: #222226; color: #fff; border: 2px solid transparent; border-radius: 6px;"
                        tabindex="0"
                    />
                    <input
                        type="text"
                        class="text-input tv-input custom-header-val"
                        placeholder="Header Value"
                        value="${valVal}"
                        data-index="${index}"
                        style="flex: 3; padding: 10px 14px; font-size: 0.95rem; background: #222226; color: #fff; border: 2px solid transparent; border-radius: 6px;"
                        tabindex="0"
                    />
                    <button
                        type="button"
                        class="btn btn-secondary modal-action-btn custom-header-toggle ${toggleClass}"
                        data-index="${index}"
                        style="padding: 10px 14px; font-size: 0.85rem; min-width: 90px; text-align: center;"
                        tabindex="0"
                    >
                        ${toggleText}
                    </button>
                    <button
                        type="button"
                        class="btn btn-secondary modal-action-btn danger-btn custom-header-delete"
                        data-index="${index}"
                        style="padding: 10px 14px; font-size: 0.85rem;"
                        tabindex="0"
                        title="${i18n.t('Delete') || 'Delete'}"
                    >
                        ✕
                    </button>
                </div>
            `;
        }).join('');
    }

    /**
     * Synchronizes current input DOM values back into memory.
     * @private
     */
    _syncInputsToMemory() {
        if (!this.overlay) return;

        const keyInputs = this.overlay.querySelectorAll('.custom-header-key');
        const valInputs = this.overlay.querySelectorAll('.custom-header-val');

        keyInputs.forEach((input) => {
            const idx = parseInt(input.getAttribute('data-index'), 10);
            if (this._headers[idx]) {
                this._headers[idx].key = input.value.trim();
            }
        });

        valInputs.forEach((input) => {
            const idx = parseInt(input.getAttribute('data-index'), 10);
            if (this._headers[idx]) {
                this._headers[idx].value = input.value.trim();
            }
        });
    }

    /**
     * Sets up event listeners for inputs, preset triggers, and action buttons.
     * @private
     */
    _bindEvents() {
        if (!this.overlay) return;

        // Add Cloudflare Preset button
        const cfBtn = this.overlay.querySelector('#preset-cf-btn');
        if (cfBtn) {
            cfBtn.onclick = (e) => {
                e.stopPropagation();
                this._syncInputsToMemory();
                const cfPreset = HEADER_PRESETS.find((p) => p.id === 'cloudflare');
                if (cfPreset) {
                    cfPreset.headers.forEach((h) => {
                        this._headers.push({ ...h, presetId: 'cloudflare' });
                    });
                }
                this._refreshList();
            };
        }

        // Add Pangolin Preset button
        const pangolinBtn = this.overlay.querySelector('#preset-pangolin-btn');
        if (pangolinBtn) {
            pangolinBtn.onclick = (e) => {
                e.stopPropagation();
                this._syncInputsToMemory();
                const pPreset = HEADER_PRESETS.find((p) => p.id === 'pangolin');
                if (pPreset) {
                    pPreset.headers.forEach((h) => {
                        this._headers.push({ ...h, presetId: 'pangolin' });
                    });
                }
                this._refreshList();
            };
        }

        // Add blank header button
        const addBtn = this.overlay.querySelector('#add-header-btn');
        if (addBtn) {
            addBtn.onclick = (e) => {
                e.stopPropagation();
                this._syncInputsToMemory();
                this._headers.push({ key: '', value: '', enabled: true });
                this._refreshList();
            };
        }

        // Save button
        const saveBtn = this.overlay.querySelector('#custom-headers-save-btn');
        if (saveBtn) {
            saveBtn.onclick = (e) => {
                e.stopPropagation();
                this._syncInputsToMemory();

                // Prune completely empty rows before saving
                const cleaned = this._headers.filter((h) => h && h.key && h.key.trim().length > 0);

                if (this._serverUrl) {
                    customHeaders.setServerHeaders(this._serverUrl, cleaned);
                }

                if (typeof this._onSave === 'function') {
                    this._onSave(cleaned);
                }

                this.close();
            };
        }

        // Cancel button
        const cancelBtn = this.overlay.querySelector('#custom-headers-cancel-btn');
        if (cancelBtn) {
            cancelBtn.onclick = (e) => {
                e.stopPropagation();
                if (typeof this._onCancel === 'function') {
                    this._onCancel();
                }
                this.close();
            };
        }

        // Row toggle & delete button handlers
        const container = this.overlay.querySelector('#custom-headers-list-container');
        if (container) {
            container.onclick = (e) => {
                const target = e.target.closest('button');
                if (!target) return;

                const idx = parseInt(target.getAttribute('data-index'), 10);
                if (isNaN(idx) || !this._headers[idx]) return;

                if (target.classList.contains('custom-header-toggle')) {
                    e.stopPropagation();
                    this._syncInputsToMemory();
                    this._headers[idx].enabled = !this._headers[idx].enabled;
                    this._refreshList();
                } else if (target.classList.contains('custom-header-delete')) {
                    e.stopPropagation();
                    this._syncInputsToMemory();
                    this._headers.splice(idx, 1);
                    this._refreshList();
                }
            };
        }

        // Backdrop click to dismiss
        this.overlay.onclick = (e) => {
            if (e.target === this.overlay) {
                if (typeof this._onCancel === 'function') {
                    this._onCancel();
                }
                this.close();
            }
        };
    }

    /**
     * Refreshes the headers container without recreating the entire modal DOM.
     * @private
     */
    _refreshList() {
        const container = this.overlay.querySelector('#custom-headers-list-container');
        if (container) {
            container.innerHTML = this._renderHeadersList();
            this._updateFocusTrap();
        }
    }

    /**
     * Locks spatial navigation into the modal dialog and selects the initial focused control.
     * @private
     */
    _updateFocusTrap() {
        if (!this.overlay) return;

        const modalDialog = this.overlay.querySelector('.settings-modal');
        if (modalDialog) {
            focusManager.pushTrap(modalDialog, {
                orientation: 'vertical',
                defaultFocusSelector: '#custom-headers-save-btn'
            });
        }
    }

    /**
     * Closes the dialog and restores previous spatial focus.
     */
    close() {
        if (!this.isVisible) return;
        this.isVisible = false;

        // Disarm focus trap
        focusManager.popTrap();

        if (this.overlay && this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
        this.overlay = null;
        log.info('Closed CustomHeadersDialog');
    }
}

export const customHeadersDialog = new CustomHeadersDialog();
