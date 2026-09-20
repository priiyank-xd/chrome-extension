// Toolbar click -> toggle the selection session in the active tab.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https?:/i.test(tab.url || '')) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'hdi-toggle' });
  } catch (e) {
    // Content script not there yet (page loaded before install / reload).
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'hdi-toggle' });
    } catch (err) {
      console.warn('Hide Distracting Items: cannot run on this page', err);
    }
  }
});
