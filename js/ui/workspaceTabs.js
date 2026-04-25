/**
 * workspaceTabs.js — Dynamic multi-instance tab system (Windows style)
 */

import { setState, getState, subscribe } from '../state.js';


// Import pages dynamically or statically
import { render as renderLibrary } from '../pages/libraryPage.js';
import { render as renderFocus } from '../pages/focusPage.js';
import { render as renderStats } from '../pages/statsPage.js';
import { render as renderRecommendations } from '../pages/recommendationsPage.js';
import { render as renderSettings } from '../pages/settingsPage.js';
import { render as renderAddAnime } from '../pages/addAnimePage.js';

const ROUTE_MAP = {
  library: renderLibrary,
  focus: renderFocus,
  stats: renderStats,
  recommendations: renderRecommendations,
  settings: renderSettings,
  add: renderAddAnime,
};

// Internal Tabs State Cache
let activeTabId = null;

export function initWorkspaceTabs() {
  if (!getState('tabs')) {
    setState('tabs', [
      { id: 'system-library', type: 'library', title: 'Library', closable: false, minimized: false, params: {} },
      { id: 'system-stats', type: 'stats', title: 'Statistics', closable: true, minimized: false, params: {} },
      { id: 'system-recommendations', type: 'recommendations', title: 'Recommendations', closable: true, minimized: false, params: {} }
    ]);
  }
  
  subscribe('tabs', renderTabs);
  
  // Listen to active tab shifts
  subscribe('activeTabId', (id) => {
    activeTabId = id;
    renderTabs();
    routeActiveTab();
  });

  // Default focus
  if (!getState('activeTabId')) {
    focusTab('system-library');
  } else {
    renderTabs();
    routeActiveTab();
  }
}

export function openTab({ id, type, title, closable = true, minimized = false, params = {} }) {
  let tabs = getState('tabs') || [];
  
  // Check if tab already exists
  const existingIndex = tabs.findIndex(t => t.id === id);
  
  if (existingIndex > -1) {
    // Un-minimize if it was
    const newTabs = [...tabs];
    newTabs[existingIndex].minimized = false;
    newTabs[existingIndex].params = params; // update params
    setState('tabs', newTabs);
    focusTab(id);
    return;
  }
  
  // Add new tab
  const newTab = { id, type, title, closable, minimized, params };
  setState('tabs', [...tabs, newTab]);
  focusTab(id);
}

export function closeTab(id) {
  let tabs = getState('tabs') || [];
  const tabIndex = tabs.findIndex(t => t.id === id);
  if (tabIndex === -1) return;
  
  const isClosingActive = (id === getState('activeTabId'));
  
  const newTabs = tabs.filter(t => t.id !== id);
  setState('tabs', newTabs);
  
  if (isClosingActive) {
    // Fallback to library or last available
    const nextTab = newTabs[newTabs.length - 1];
    if (nextTab) {
      nextTab.minimized = false; // ensure not minimized
      focusTab(nextTab.id);
    } else {
      openTab({ type: 'library', id: 'system-library', title: 'Library', closable: false });
    }
  } else {
    renderTabs();
  }
}

export function minimizeTab(id) {
  let tabs = getState('tabs') || [];
  const newTabs = [...tabs];
  const tab = newTabs.find(t => t.id === id);
  if (!tab) return;
  
  tab.minimized = true;
  setState('tabs', newTabs);
  
  if (id === getState('activeTabId')) {
    // Fallback focus to next available non-minimized tab
    const nextUnminimized = newTabs.filter(t => !t.minimized)[0];
    if (nextUnminimized) focusTab(nextUnminimized.id);
    else focusTab('system-library'); // force library open if nothing else
  }
}

export function focusTab(id) {
  const tabs = getState('tabs') || [];
  const tab = tabs.find(t => t.id === id);
  
  if (tab && tab.minimized) {
    tab.minimized = false;
    setState('tabs', [...tabs]);
  }
  
  setState('activeTabId', id);
}

function renderTabs() {
  const tabs = getState('tabs') || [];
  const activeId = getState('activeTabId');
  
  const tabBar = document.getElementById('tab-bar');
  const tabShelf = document.getElementById('tab-shelf');
  if (!tabBar || !tabShelf) return;
  
  const activeTabs = tabs.filter(t => !t.minimized);
  const minimizedTabs = tabs.filter(t => t.minimized);
  
  // Render Bar
  tabBar.innerHTML = activeTabs.map(t => `
    <div class="workspace-tab ${t.id === activeId ? 'active' : ''}" data-id="${t.id}">
      <span class="tab-title">${t.title}</span>
      <div class="tab-controls">
        <button class="tab-minimize-btn" title="Minimize">_</button>
        ${t.closable ? `<button class="tab-close-btn" title="Close">×</button>` : ''}
      </div>
    </div>
  `).join('');
  
  // Render Shelf
  tabShelf.innerHTML = minimizedTabs.map(t => `
    <div class="minimized-pill" data-id="${t.id}" title="${t.title}">
      ${t.title}
    </div>
  `).join('');
  
  if (minimizedTabs.length === 0) {
    tabShelf.classList.add('empty');
  } else {
    tabShelf.classList.remove('empty');
  }
  
  // Bind Events for Active Tabs
  tabBar.querySelectorAll('.workspace-tab').forEach(el => {
    el.addEventListener('click', (e) => {
      // Ignore if parsing a sub-button
      if (e.target.closest('button')) return;
      focusTab(el.dataset.id);
    });
    
    el.querySelector('.tab-minimize-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      minimizeTab(el.dataset.id);
    });
    
    el.querySelector('.tab-close-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(el.dataset.id);
    });
  });
  
  // Bind Events for Minimized Tabs
  tabShelf.querySelectorAll('.minimized-pill').forEach(el => {
    el.addEventListener('click', () => {
      focusTab(el.dataset.id);
    });
  });
}

function routeActiveTab() {
  const tabs = getState('tabs') || [];
  const activeId = getState('activeTabId');
  const activeTab = tabs.find(t => t.id === activeId);
  const workspace = document.getElementById('workspace');
  
  if (!workspace || !activeTab) return;

  // expose active tab type/params to rest of app
  setState('activeTab', activeTab.type);
  setState('routeParams', activeTab.params || {});
  
  const renderer = ROUTE_MAP[activeTab.type];
  if (renderer) {
    workspace.innerHTML = '';
    workspace.classList.add('page-enter');
    
    // Provide generic padding container for all tabs
    let renderContainer = document.createElement('div');
    renderContainer.className = 'page-content';
    workspace.appendChild(renderContainer);
    
    renderer(renderContainer, activeTab.params);
    workspace.addEventListener('animationend', () => workspace.classList.remove('page-enter'), { once: true });
  } else {
    workspace.innerHTML = `<div style="padding:40px;text-align:center;color:white;">Page not found</div>`;
  }
}
