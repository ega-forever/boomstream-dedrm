import Semaphore from '../browser/vendor/semaphore';

declare const chrome: any;

const states = {
  STOPPED: 0,
  LISTEN: 1,
  ERR: 2
};
const stateBadgeTexts = {
  [states.STOPPED]: 'OFF',
  [states.LISTEN]: 'ON',
  [states.ERR]: 'ERR'
};

let pluginState: { [key: string]: number } = null;

const statePerTab: Map<string, {
  semaphore: Semaphore,
  processedUrls: Set<string>,
  isOnTrack: boolean
}> = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'boomstream-fetch') {
    return;
  }

  let url: URL;
  try {
    url = new URL(message.url);
  } catch {
    sendResponse({ error: 'Invalid segment URL' });
    return;
  }

  if (!sender.tab || url.protocol !== 'https:' || !url.hostname.endsWith('.boomstream.com')) {
    sendResponse({ error: 'Segment URL is not permitted' });
    return;
  }

  void (async () => {
    try {
      const response = await fetch(url.href, {
        method: 'GET',
        headers: message.headers
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const parts: string[] = [];
      for (let i = 0; i < bytes.length; i += 32768) {
        parts.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
      }
      sendResponse({
        status: response.status,
        statusText: response.statusText,
        body: btoa(parts.join(''))
      });
    } catch (error) {
      sendResponse({ error: String(error) });
    }
  })();
  return true;
});

const setBadgeForWebsiteByTab = async (tab) => {
  const website = new URL(tab.url).origin;
  const tabsForTheWebsite = (await chrome.tabs.query({}))
    .filter(foundTab => {
      const foundTabWebsite = new URL(foundTab.url).origin;
      return foundTabWebsite === website;
    });

  for (const foundTab of tabsForTheWebsite) {
    await chrome.action.setBadgeText({
      tabId: foundTab.id,
      text: stateBadgeTexts[pluginState[website] ? states.LISTEN : states.STOPPED]
    });
  }
};

const injectScriptIntoTab = async (tabId) => {
  chrome.scripting.executeScript({
    target: { tabId: tabId, allFrames: false },
    files: [
      'inject.js'
    ]
  });
};

const updateTabState = async (tabId)=>{
  const tab = await chrome.tabs.get(tabId);
  const website = new URL(tab.url)?.origin;

  statePerTab.set(tabId, {
    semaphore: new Semaphore(1),
    processedUrls: new Set(),
    isOnTrack: !!(website && pluginState[website])
  });
};

chrome.webNavigation.onCommitted.addListener(async (info) => {
  pluginState = await chrome.storage.session.get();

  await updateTabState(info.tabId);

  if (statePerTab.get(info.tabId).isOnTrack && info.frameId === 0) {
    await injectScriptIntoTab(info.tabId);
  }

  await setBadgeForWebsiteByTab(info);
});

chrome.action.onClicked.addListener(async (tab) => {
  const website = new URL(tab.url).origin;
  const tabsForTheWebsite = (await chrome.tabs.query({}))
    .filter(foundTab => {
      const foundTabWebsite = new URL(foundTab.url).origin;
      return foundTabWebsite === website;
    });

  if (!pluginState[website]) {
    await injectScriptIntoTab(tab.id);
    pluginState[website] = 1;
    await chrome.storage.session.set({ [website]: 1 });
    await updateTabState(tab.id);
  } else {
    delete pluginState[website];
    await chrome.storage.session.remove(website);
    await updateTabState(tab.id);

    for (const foundTab of tabsForTheWebsite) {
      chrome.tabs.reload(foundTab.id);
    }
  }

  await setBadgeForWebsiteByTab(tab);
});

chrome.webRequest.onBeforeSendHeaders.addListener(async (request) => {
  if (request.tabId === -1 || !statePerTab.get(request.tabId)?.isOnTrack) {
    return;
  }

  const tabState = statePerTab.get(request.tabId);
  const ext = request.url.split('?')[0].split('#')[0].split('.').pop();
  if ((!request.url.includes('/process/') && ext !== 'm3u8') || tabState.processedUrls.has(request.url)) {
    return;
  }

  tabState.processedUrls.add(request.url);
  await tabState.semaphore.acquire();


  const headers = request.requestHeaders.reduce((prev, current) => {
    prev[current.name] = current.value;
    return prev;
  }, {});


  await chrome.tabs.sendMessage(request.tabId, {
    url: request.url,
    headers
  });

  tabState.semaphore.release();
  // do something with response here, not outside the function
}, { urls: ['<all_urls>'] }, ['requestHeaders', 'extraHeaders']);
