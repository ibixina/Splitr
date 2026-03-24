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
            this.pageKey = `splitview_${window.location.hostname}`;

            this.init();
        }

        init() {
            this._setupLinkInterception();
            this._setupKeyboardShortcuts();

            chrome.storage.local.get(
                ['splitview_active_pages', 'splitview_scroll_y', 'splitview_csp_ready'],
                (result) => {
                    if (chrome.runtime.lastError) return;

                    const activePages = result.splitview_active_pages || {};
                    if (!activePages[this.pageKey]) return;

                    if (result.splitview_csp_ready === this.pageKey) {
                        chrome.storage.local.remove(['splitview_csp_ready']);
                        this._restoreActiveState(result.splitview_scroll_y || 0);
                    } else {
                        this._enableBypassAndReload();
                    }
                }
            );
        }

        // ===== Storage =====

        async _loadSavedWidth() {
            return new Promise((resolve) => {
                chrome.storage.local.get([this.pageKey], (result) => {
                    if (chrome.runtime.lastError) { resolve(); return; }
                    if (result[this.pageKey]?.width) {
                        this.panelWidth = result[this.pageKey].width;
                    }
                    resolve();
                });
            });
        }

        _saveState() {
            chrome.storage.local.set({ [this.pageKey]: { width: this.panelWidth } });
        }

        // ===== UI Creation (lazy) =====

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

            const contentWrapper = document.createElement('div');
            contentWrapper.className = 'splitview-content-wrapper';

            const closeBtn = document.createElement('button');
            closeBtn.className = 'splitview-close-btn';
            closeBtn.innerHTML = '✕';
            closeBtn.title = 'Close panel (split view stays active)';
            closeBtn.addEventListener('click', () => this._hidePanel());
            contentWrapper.appendChild(closeBtn);

            this.iframe = document.createElement('iframe');
            this.iframe.className = 'splitview-iframe';
            this.iframe.setAttribute('sandbox',
                'allow-same-origin allow-scripts allow-popups allow-forms allow-modals allow-popups-to-escape-sandbox');
            this.iframe.setAttribute('allow',
                'camera; clipboard-write; fullscreen; microphone; geolocation; autoplay; encrypted-media;');
            contentWrapper.appendChild(this.iframe);

            this.panel.appendChild(contentWrapper);
            document.body.appendChild(this.panel);
            this._setupResizer();
        }

        // ===== Page layout =====

        _pushPage() {
            const pw = this.panelWidth;
            const available = `calc(100vw - ${pw}px)`;
            const html = document.documentElement;
            const body = document.body;

            // Constrain both html and body — min-width:0 overrides
            // sites that set min-width to prevent shrinking
            html.style.setProperty('width', available, 'important');
            html.style.setProperty('max-width', available, 'important');
            html.style.setProperty('min-width', '0', 'important');
            html.style.setProperty('overflow-x', 'hidden', 'important');

            body.style.setProperty('width', '100%', 'important');
            body.style.setProperty('max-width', '100%', 'important');
            body.style.setProperty('min-width', '0', 'important');
            body.style.setProperty('overflow-x', 'hidden', 'important');

            this._injectConstraintCSS(pw);
            this._constrainFixedElements(pw);
        }

        _unpushPage() {
            const html = document.documentElement;
            const body = document.body;

            for (const prop of ['width', 'max-width', 'min-width', 'overflow-x']) {
                html.style.removeProperty(prop);
                body.style.removeProperty(prop);
            }

            const s = document.getElementById('splitview-constraint-css');
            if (s) s.remove();

            // Restore any elements we individually constrained
            document.querySelectorAll('[data-splitview-constrained]').forEach(el => {
                el.style.removeProperty('max-width');
                el.style.removeProperty('box-sizing');
                el.style.removeProperty('right');
                el.removeAttribute('data-splitview-constrained');
            });
        }

        // Injected stylesheet: constrain body's direct children so they
        // can't exceed body width (catches app shells like ytd-app)
        _injectConstraintCSS(pw) {
            let style = document.getElementById('splitview-constraint-css');
            if (!style) {
                style = document.createElement('style');
                style.id = 'splitview-constraint-css';
                document.head.appendChild(style);
            }
            style.textContent = `
                body.splitview-active > *:not(.splitview-panel):not(.splitview-active-indicator) {
                    max-width: calc(100vw - ${pw}px) !important;
                    min-width: 0 !important;
                    box-sizing: border-box !important;
                    overflow-x: hidden !important;
                }
            `;
        }

        // Find actual fixed/sticky elements and constrain them individually
        _constrainFixedElements(pw) {
            const selectors = 'header, nav, footer, [role="banner"], [role="navigation"]';
            const candidates = document.querySelectorAll(selectors);
            // Also check body's direct children
            const bodyChildren = document.body.children;

            const check = (el) => {
                if (!el || el === this.panel || el === this.activeIndicator) return;
                if (el.closest('.splitview-panel')) return;
                const pos = getComputedStyle(el).position;
                if (pos === 'fixed' || pos === 'sticky') {
                    el.style.setProperty('max-width', `calc(100vw - ${pw}px)`, 'important');
                    el.style.setProperty('box-sizing', 'border-box', 'important');
                    el.setAttribute('data-splitview-constrained', '');
                }
            };

            candidates.forEach(check);
            for (const child of bodyChildren) check(child);
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
            this.isActive ? this.deactivate() : this.activate();
        }

        async activate() {
            await this._ensureUICreated();
            this.isActive = true;
            this.activeIndicator.style.display = 'block';
            document.body.classList.add('splitview-active');

            chrome.storage.local.get(['splitview_active_pages'], (result) => {
                if (chrome.runtime.lastError) return;
                const activePages = result.splitview_active_pages || {};
                activePages[this.pageKey] = true;

                chrome.storage.local.set({
                    splitview_active_pages: activePages,
                    splitview_scroll_y: window.scrollY,
                    splitview_csp_ready: this.pageKey
                }, () => {
                    if (chrome.runtime.lastError) return;
                    chrome.runtime.sendMessage({ action: 'enableHeaderBypass' }, () => {
                        if (chrome.runtime.lastError) {
                            console.error('[SplitView] Header bypass failed:', chrome.runtime.lastError);
                        }
                        window.location.reload();
                    });
                });
            });
        }

        _enableBypassAndReload() {
            // Circuit breaker: prevent infinite reload loops
            const reloadKey = 'splitview_reload_count_' + this.pageKey;
            const reloadCount = parseInt(sessionStorage.getItem(reloadKey) || '0', 10);
            if (reloadCount >= 2) {
                sessionStorage.removeItem(reloadKey);
                // Too many reloads — just activate without CSP bypass
                this._restoreActiveState(0);
                return;
            }
            sessionStorage.setItem(reloadKey, String(reloadCount + 1));

            chrome.storage.local.set({
                splitview_csp_ready: this.pageKey,
                splitview_scroll_y: 0
            }, () => {
                if (chrome.runtime.lastError) return;
                chrome.runtime.sendMessage({ action: 'enableHeaderBypass' }, () => {
                    if (chrome.runtime.lastError) {
                        console.error('[SplitView] Header bypass failed:', chrome.runtime.lastError);
                    }
                    window.location.reload();
                });
            });
        }

        async _restoreActiveState(scrollY) {
            // Clear reload counter on successful restore
            sessionStorage.removeItem('splitview_reload_count_' + this.pageKey);

            await this._ensureUICreated();
            this.isActive = true;
            this.activeIndicator.style.display = 'block';
            document.body.classList.add('splitview-active');
            this._showToast('SplitView Active — Click any link');

            if (scrollY > 0) {
                requestAnimationFrame(() => window.scrollTo(0, scrollY));
                chrome.storage.local.remove(['splitview_scroll_y']);
            }
        }

        deactivate() {
            this.isActive = false;
            this.panelVisible = false;

            if (this.panel) this.panel.style.display = 'none';
            if (this.activeIndicator) this.activeIndicator.style.display = 'none';
            if (this.iframe) this.iframe.src = '';

            document.body.classList.remove('splitview-active');
            this._unpushPage();

            chrome.storage.local.get(['splitview_active_pages'], (result) => {
                if (chrome.runtime.lastError) return;
                const activePages = result.splitview_active_pages || {};
                delete activePages[this.pageKey];
                chrome.storage.local.set({ splitview_active_pages: activePages });
            });
            chrome.runtime.sendMessage({ action: 'disableHeaderBypass' }, () => {
                if (chrome.runtime.lastError) { /* tab might be closing */ }
            });
        }

        _hidePanel() {
            this.panelVisible = false;
            if (this.panel) this.panel.style.display = 'none';
            if (this.iframe) this.iframe.src = '';
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
            let lastClickedHref = null;
            let lastClickTime = 0;
            let pendingOpen = null;
            const DOUBLE_CLICK_THRESHOLD = 400;

            // Capture phase: intercept BEFORE SPA routers (YouTube, React, etc.)
            // can call preventDefault and do their own navigation
            document.addEventListener('click', (e) => {
                if (!this.isActive) return;

                const link = e.target.closest('a');
                if (!link) return;

                const href = link.href;
                if (!href || href.startsWith('javascript:') || href.startsWith('#')) return;
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                if (link.hasAttribute('download')) return;
                if (link.target === '_blank') return;

                let linkUrl;
                try { linkUrl = new URL(href, window.location.href); } catch { return; }

                // Skip same-page hash links
                if (linkUrl.origin === window.location.origin &&
                    linkUrl.pathname === window.location.pathname &&
                    linkUrl.hash) return;

                const now = Date.now();
                const isDoubleClick = lastClickedHref === href &&
                    (now - lastClickTime) < DOUBLE_CLICK_THRESHOLD;

                lastClickedHref = href;
                lastClickTime = now;

                if (isDoubleClick) {
                    // Double-click: cancel pending open and let browser navigate normally
                    if (pendingOpen) {
                        clearTimeout(pendingOpen);
                        pendingOpen = null;
                    }
                    return;
                }

                // First click: delay opening to wait for potential double-click
                e.preventDefault();
                e.stopPropagation();

                pendingOpen = setTimeout(() => {
                    pendingOpen = null;
                    this.openUrl(href);
                    this._showLinkToast(href);
                }, DOUBLE_CLICK_THRESHOLD);
            }, true); // <-- capture phase
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
            try { domain = new URL(url).hostname; } catch { domain = url; }

            const toast = document.createElement('div');

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

            const rightOffset = this.panelVisible ? this.panelWidth + 20 : 20;
            toast.style.cssText = `
                position: fixed;
                bottom: 20px;
                right: ${rightOffset}px;
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
