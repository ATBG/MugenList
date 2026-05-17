/**
 * router.js — SPA tab/page routing mapped to Workspace Tabs logic
 */

import { getState } from './state.js';
import { openTab } from './ui/workspaceTabs.js';

export function navigate(tabId, params = {}) {
  const overrides = params.force; // optional bypass

  const titleMap = {
    library: 'Library',
    stats: 'Statistics',
    recommendations: 'Recommendations',
    settings: 'Settings',
    add: 'Add Anime',
  };

  if (tabId === 'focus') {
    openTab({
      id: `focus-${params.rootId}`,
      type: 'focus',
      title: params.title || 'Focus',
      closable: true,
      params: params
    });
  } else {
    openTab({
      id: `system-${tabId}`,
      type: tabId,
      title: titleMap[tabId] || tabId,
      closable: tabId !== 'library',
      params: params
    });
  }
}

export function getCurrentTab() {
  const tabs = getState('tabs') || [];
  const activeId = getState('activeTabId');
  const activeTab = tabs.find(t => t.id === activeId);
  return activeTab ? activeTab.type : null;
}

export function getRouteParams() {
  const tabs = getState('tabs') || [];
  const activeId = getState('activeTabId');
  const activeTab = tabs.find(t => t.id === activeId);
  return activeTab ? activeTab.params : {};
}

// Deprecated for generic router, but maintained for isolated hooks
export function registerRoute(tabId, renderFn) {
  // Routes are now hard-bound inside workspaceTabs.js ROUTE_MAP
}
