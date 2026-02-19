// Background service worker for SplitView v2

// Track which tabs have active bypass rules (rule ID = tabId to avoid collisions)
const activeTabRules = new Set();

// Strip frame-blocking headers only for sub_frame requests on a specific tab
async function enableHeaderBypass(tabId) {
    if (!tabId) {
        console.error('[SplitView] Cannot enable header bypass: no tabId provided');
        return;
    }

    try {
        // Use tabId as the rule ID so each tab gets its own rule
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [tabId],
            addRules: [{
                id: tabId,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    responseHeaders: [
                        { header: 'x-frame-options', operation: 'remove' },
                        { header: 'content-security-policy', operation: 'remove' },
                        { header: 'content-security-policy-report-only', operation: 'remove' }
                    ]
                },
                condition: {
                    resourceTypes: ['sub_frame', 'main_frame'],
                    tabIds: [tabId]
                }
            }]
        });
        activeTabRules.add(tabId);
    } catch (e) {
        console.error('[SplitView] Failed to enable header bypass for tab', tabId, ':', e);
    }
}

// Remove the header bypass rule for a specific tab
async function disableHeaderBypass(tabId) {
    if (!tabId) {
        console.error('[SplitView] Cannot disable header bypass: no tabId provided');
        return;
    }

    try {
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [tabId]
        });
        activeTabRules.delete(tabId);
    } catch (e) {
        console.error('[SplitView] Failed to disable header bypass for tab', tabId, ':', e);
    }
}

// Toggle extension state when icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
    if (!tab.id) return;

    chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
            if (window.splitViewExtension) {
                window.splitViewExtension.toggle();
            }
        }
    });
});

// Clean up rules when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
    if (activeTabRules.has(tabId)) {
        disableHeaderBypass(tabId);
    }
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const tabId = sender.tab?.id;

    if (request.action === 'enableHeaderBypass') {
        enableHeaderBypass(tabId).then(() => {
            sendResponse({ success: true });
        });
        return true;
    } else if (request.action === 'disableHeaderBypass') {
        disableHeaderBypass(tabId).then(() => {
            sendResponse({ success: true });
        });
        return true;
    }
});
