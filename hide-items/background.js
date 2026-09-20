/* Session state lives here so every frame in a tab stays in step. */
const sessions = new Set();

const broadcast = (tabId, msg) =>
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});

const toTop = (tabId, msg) =>
  chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {});

async function ensureInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'hdi-ping' }, { frameId: 0 });
  } catch (e) {
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true }, files: ['content.css']
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, files: ['content.js']
    });
  }
}

/* ------------------------------ toolbar ----------------------------- */

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https?:/i.test(tab.url || '')) return;

  if (sessions.has(tab.id)) {
    sessions.delete(tab.id);
    broadcast(tab.id, { type: 'hdi-cancel' });
    return;
  }

  try {
    await ensureInjected(tab.id);
    sessions.add(tab.id);
    broadcast(tab.id, { type: 'hdi-start' });
  } catch (err) {
    console.warn('Hide Distracting Items: cannot run on this page', err);
  }
});

/* --------------------------- context menu --------------------------- */

const MENU = [
  { id: 'hdi-hide-site', title: 'Hide This Element on This Site' },
  { id: 'hdi-hide-page', title: 'Hide This Element on This Page' },
  { id: 'hdi-sep', type: 'separator' },
  { id: 'hdi-show', title: 'Show All Hidden Here' }
];

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'hdi-root', title: 'Hide Distracting Items', contexts: ['all']
    });
    for (const item of MENU) {
      chrome.contextMenus.create({ ...item, parentId: 'hdi-root', contexts: ['all'] });
    }
  });
}

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  const frameId = info.frameId || 0;

  try {
    await ensureInjected(tab.id);
  } catch (e) {
    return;
  }

  if (info.menuItemId === 'hdi-show') {
    broadcast(tab.id, { type: 'hdi-unhide' });
    return;
  }
  if (info.menuItemId === 'hdi-hide-site' || info.menuItemId === 'hdi-hide-page') {
    const scope = info.menuItemId === 'hdi-hide-page' ? 'page' : 'site';
    chrome.tabs.sendMessage(tab.id, { type: 'hdi-ctx-hide', scope }, { frameId })
      .catch(() => {});
  }
});

/* ----------------------------- relaying ----------------------------- */

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab && sender.tab.id;
  if (!tabId || !msg) return false;

  switch (msg.type) {
    case 'hdi-commit':
      sessions.delete(tabId);
      broadcast(tabId, { type: 'hdi-apply', scope: msg.scope });
      break;
    case 'hdi-discard':
      sessions.delete(tabId);
      broadcast(tabId, { type: 'hdi-cancel' });
      break;
    case 'hdi-unhide-all':
      broadcast(tabId, { type: 'hdi-unhide' });
      break;
    case 'hdi-undo':
      broadcast(tabId, { type: 'hdi-undo-last' });
      break;
    case 'hdi-frame-count':
      toTop(tabId, { type: 'hdi-count', frameId: sender.frameId, n: msg.n });
      break;
    case 'hdi-pointer':
      toTop(tabId, { type: 'hdi-frame-pointer', on: msg.on });
      break;
    case 'hdi-toast':
      toTop(tabId, { type: 'hdi-toast', text: msg.text });
      break;
    default:
      break;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => sessions.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') sessions.delete(tabId);
});
