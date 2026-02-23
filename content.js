// Content script for SplitView v2 — Injected DOM panel

(function () {
    'use strict';

    if (window.splitViewExtension) return;

    const DEFAULT_PANEL_WIDTH = 450;
    const MIN_PANEL_WIDTH = 200;
    const MAX_PANEL_WIDTH_RATIO = 0.8;
    const Z_INDEX_PANEL = 2147483645;
    const Z_INDEX_INDICATOR = 2147483646;
    const Z_INDEX_TOAST = 2147483647;

    class SplitViewExtension {
        constructor() {
            this.isActive = false;
            this.panelVisible = false;
            this.panelWidth = DEFAULT_PANEL_WIDTH;
            this.panel = null;
            this.resizer = null;
            this.iframe = null;
            this.activeIndicator = null;
            this.isDragging = false;
            this._uiCreated = false;
            this.pageKey = `splitview_${window.location.hostname}${window.location.pathname}`;

            this.init();
        }

        init() {
            this._setupLinkInterception();
            this._setupKeyboardShortcuts();

            // Check if we should be active on this page
            chrome.storage.local.get(
                ['splitview_active_pages', 'splitview_scroll_y', 'splitview_csp_ready'],
                (result) => {
                    if (chrome.runtime.lastError) {
                        console.error('[SplitView] Failed to load active state:', chrome.runtime.lastError);
                        return;
                    }

                    const activePages = result.splitview_active_pages || {};
                    if (!activePages[this.pageKey]) return;

                    if (result.splitview_csp_ready === this.pageKey) {
                        // CSP headers were already bypassed (we just reloaded) — restore state
                        chrome.storage.local.remove(['splitview_csp_ready']);
                        this._restoreActiveState(result.splitview_scroll_y || 0);
                    } else {
                        // Fresh visit — need to enable CSP bypass and reload
                        this._enableBypassAndReload();
                    }
                }
            );
        }

        // ===== Storage =====

        async _loadSavedWidth() {
            return new Promise((resolve) => {
                chrome.storage.local.get([this.pageKey], (result) => {
                    if (chrome.runtime.lastError) {
                        console.error('[SplitView] Failed to load saved width:', chrome.runtime.lastError);
                        resolve();
                        return;
                    }
                    if (result[this.pageKey] && result[this.pageKey].width) {
                        this.panelWidth = result[this.pageKey].width;
                    }
                    resolve();
                });
            });
        }

        _saveState() {
            chrome.storage.local.set({
                [this.pageKey]: { width: this.panelWidth }
            }, () => {
                if (chrome.runtime.lastError) {
                    console.error('[SplitView] Failed to save state:', chrome.runtime.lastError);
                }
            });
        }

        // ===== UI Creation (lazy — only when activated) =====

        async _ensureUICreated() {
            if (this._uiCreated) return;
            this._uiCreated = true;
            await this._loadSavedWidth();
            this._createActiveIndicator();
            this._createPanel();
        }

        _createActiveIndicator() {
            this.activeIndicator = document.createElement('div');
            this.activeIndicator.className = 'splitview-active-indicator';
            document.body.appendChild(this.activeIndicator);
        }

        _createPanel() {
            this.panel = document.createElement('div');
            this.panel.className = 'splitview-panel';
            this.panel.style.width = this.panelWidth + 'px';
            this.panel.style.display = 'none';

            this.resizer = document.createElement('div');
            this.resizer.className = 'splitview-resizer';
            this.panel.appendChild(this.resizer);

            // Content wrapper (holds close button + iframe)
            const contentWrapper = document.createElement('div');
            contentWrapper.className = 'splitview-content-wrapper';

            // Close button — hides panel but keeps split view active
            const closeBtn = document.createElement('button');
            closeBtn.className = 'splitview-close-btn';
            closeBtn.innerHTML = '✕';
            closeBtn.title = 'Close panel (split view stays active)';
            closeBtn.addEventListener('click', () => this._hidePanel());
            contentWrapper.appendChild(closeBtn);

            this.iframe = document.createElement('iframe');
            this.iframe.className = 'splitview-iframe';
            this.iframe.setAttribute('allow',
                'camera; clipboard-write; fullscreen; microphone; geolocation; autoplay; encrypted-media;');
            contentWrapper.appendChild(this.iframe);

            this.panel.appendChild(contentWrapper);

            document.body.appendChild(this.panel);
            this._setupResizer();
        }

        // ===== Page layout =====

        _pushPage() {
            // Set width on <html> to force ALL content to reflow, not just body margin
            document.documentElement.style.setProperty(
                'width', `calc(100% - ${this.panelWidth}px)`, 'important'
            );
            document.documentElement.style.setProperty('overflow-x', 'hidden', 'important');
        }

        _unpushPage() {
            document.documentElement.style.removeProperty('width');
            document.documentElement.style.removeProperty('overflow-x');
        }

        // ===== Resize =====

        _setupResizer() {
            let startX, startWidth;

            const onMouseDown = (e) => {
                e.preventDefault();
                this.isDragging = true;
                startX = e.clientX;
                startWidth = this.panelWidth;
                this.resizer.classList.add('dragging');
                this.iframe.style.pointerEvents = 'none';
                document.body.style.setProperty('user-select', 'none', 'important');
                document.body.style.setProperty('cursor', 'col-resize', 'important');
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            };

            const onMouseMove = (e) => {
                if (!this.isDragging) return;
                const delta = startX - e.clientX;
                const maxWidth = window.innerWidth * MAX_PANEL_WIDTH_RATIO;
                const newWidth = Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, startWidth + delta));
                this.panelWidth = Math.round(newWidth);
                this.panel.style.width = this.panelWidth + 'px';
                this._pushPage();
            };

            const onMouseUp = () => {
                this.isDragging = false;
                this.resizer.classList.remove('dragging');
                this.iframe.style.pointerEvents = '';
                document.body.style.removeProperty('user-select');
                document.body.style.removeProperty('cursor');
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                this._saveState();
            };

            this.resizer.addEventListener('mousedown', onMouseDown);
        }

        // ===== Activate / Deactivate =====

        toggle() {
            if (this.isActive) {
                this.deactivate();
            } else {
                this.activate();
            }
        }

        async activate() {
            await this._ensureUICreated();
            this.isActive = true;
            this.activeIndicator.style.display = 'block';
            document.body.classList.add('splitview-active');

            // Mark this page as persistently active, save scroll, then reload with CSP bypass
            chrome.storage.local.get(['splitview_active_pages'], (result) => {
                if (chrome.runtime.lastError) {
                    console.error('[SplitView] Failed to read active pages:', chrome.runtime.lastError);
                    return;
                }
                const activePages = result.splitview_active_pages || {};
                activePages[this.pageKey] = true;

                chrome.storage.local.set({
                    splitview_active_pages: activePages,
                    splitview_scroll_y: window.scrollY,
                    splitview_csp_ready: this.pageKey
                }, () => {
                    if (chrome.runtime.lastError) {
                        console.error('[SplitView] Failed to save active state:', chrome.runtime.lastError);
                        return;
                    }
                    chrome.runtime.sendMessage({ action: 'enableHeaderBypass' }, () => {
                        if (chrome.runtime.lastError) {
                            console.error('[SplitView] Failed to enable header bypass:', chrome.runtime.lastError);
                        }
                        window.location.reload();
                    });
                });
            });
        }

        // Enable CSP bypass for a fresh visit and reload once
        _enableBypassAndReload() {
            chrome.storage.local.set({
                splitview_csp_ready: this.pageKey,
                splitview_scroll_y: 0
            }, () => {
                if (chrome.runtime.lastError) {
                    console.error('[SplitView] Failed to set CSP ready flag:', chrome.runtime.lastError);
                    return;
                }
                chrome.runtime.sendMessage({ action: 'enableHeaderBypass' }, () => {
                    if (chrome.runtime.lastError) {
                        console.error('[SplitView] Failed to enable header bypass:', chrome.runtime.lastError);
                    }
                    window.location.reload();
                });
            });
        }

        // Called after reload to restore active state without re-reloading
        async _restoreActiveState(scrollY) {
            await this._ensureUICreated();
            this.isActive = true;
            this.activeIndicator.style.display = 'block';
            document.body.classList.add('splitview-active');
            this._showToast('SplitView Active — Click any link');

            // Restore scroll position
            if (scrollY > 0) {
                requestAnimationFrame(() => window.scrollTo(0, scrollY));
                chrome.storage.local.remove(['splitview_scroll_y']);
            }
        }

        deactivate() {
            this.isActive = false;
            this.panelVisible = false;

            this.panel.style.display = 'none';
            this.activeIndicator.style.display = 'none';
            this.iframe.src = '';

            document.body.classList.remove('splitview-active');
            this._unpushPage();

            // Remove this page from persistent active pages and disable header bypass
            chrome.storage.local.get(['splitview_active_pages'], (result) => {
                if (chrome.runtime.lastError) {
                    console.error('[SplitView] Failed to read active pages:', chrome.runtime.lastError);
                    return;
                }
                const activePages = result.splitview_active_pages || {};
                delete activePages[this.pageKey];

                chrome.storage.local.set({ splitview_active_pages: activePages }, () => {
                    if (chrome.runtime.lastError) {
                        console.error('[SplitView] Failed to clear active state:', chrome.runtime.lastError);
                    }
                });
            });
            chrome.runtime.sendMessage({ action: 'disableHeaderBypass' }, () => {
                if (chrome.runtime.lastError) {
                    console.error('[SplitView] Failed to disable header bypass:', chrome.runtime.lastError);
                }
            });
        }

        // Hide panel but keep split view active (clicking a new link reopens it)
        _hidePanel() {
            this.panelVisible = false;
            this.panel.style.display = 'none';
            this.iframe.src = '';
            this._unpushPage();
        }

        // ===== Open URL =====

        _showPanel() {
            if (!this.panelVisible) {
                this.panelVisible = true;
                this.panel.style.display = 'flex';
                this._pushPage();
            }
        }

        openUrl(url) {
            this._showPanel();
            this.iframe.src = url;
        }

        // ===== Link Interception =====

        _setupLinkInterception() {
            // Bubble phase: let the page's own handlers (SPA routers, dynamic
            // content loaders) run first. If they called preventDefault(), the
            // page is handling navigation dynamically — we leave it alone.
            // Only links whose default action (full page load) was NOT prevented
            // get intercepted into the split view panel.
            document.addEventListener('click', (e) => {
                if (!this.isActive) return;
                if (e.defaultPrevented) return; // Page handled it dynamically

                const link = e.target.closest('a');
                if (!link) return;

                const href = link.href;
                if (!href || href.startsWith('javascript:') || href.startsWith('#')) return;
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                if (link.hasAttribute('download')) return;

                // Skip same-page hash links (e.g. /page#section)
                let linkUrl;
                try { linkUrl = new URL(href, window.location.href); } catch { return; }
                if (linkUrl.origin === window.location.origin &&
                    linkUrl.pathname === window.location.pathname &&
                    linkUrl.hash) return;

                e.preventDefault();
                e.stopPropagation();

                this.openUrl(href);
                this._showLinkToast(href);
            }); // bubble phase — no capture flag
        }

        // ===== Keyboard =====

        _setupKeyboardShortcuts() {
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.isActive && this.panelVisible) {
                    this._hidePanel();
                }
            });
        }

        // ===== Toasts =====

        _showToast(message) {
            const toast = document.createElement('div');
            toast.textContent = message;
            toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: #333;
        color: white;
        padding: 12px 24px;
        border-radius: 8px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        z-index: ${Z_INDEX_TOAST};
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        animation: splitview-fade-in-out 3s ease-in-out;
        pointer-events: none;
      `;
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 3000);
        }

        _showLinkToast(url) {
            let domain;
            try { domain = new URL(url).hostname; } catch (e) { domain = url; }

            const toast = document.createElement('div');

            // Build toast content safely (no innerHTML with untrusted data)
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'display:flex;align-items:center;gap:10px';

            const checkmark = document.createElement('span');
            checkmark.style.fontSize = '20px';
            checkmark.textContent = '✓';
            wrapper.appendChild(checkmark);

            const textBlock = document.createElement('div');
            const title = document.createElement('div');
            title.style.fontWeight = '600';
            title.textContent = 'Opened in Split View';
            textBlock.appendChild(title);

            const subtitle = document.createElement('div');
            subtitle.style.cssText = 'font-size:12px;opacity:0.9';
            subtitle.textContent = domain;
            textBlock.appendChild(subtitle);

            wrapper.appendChild(textBlock);
            toast.appendChild(wrapper);

            toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: ${this.panelWidth + 20}px;
        background: #5c2d91;
        color: white;
        padding: 16px 20px;
        border-radius: 10px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        z-index: ${Z_INDEX_TOAST};
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        animation: splitview-slide-in 0.3s ease;
        max-width: 300px;
        pointer-events: none;
      `;
            document.body.appendChild(toast);
            setTimeout(() => {
                toast.style.animation = 'splitview-slide-in 0.3s ease reverse';
                setTimeout(() => toast.remove(), 300);
            }, 2000);
        }
    }

    window.splitViewExtension = new SplitViewExtension();
})();
