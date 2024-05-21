import Semaphore from './semaphore.js';
import m3u8Parser from './vendor/m3u8Parser.js';
import decryptor from './decryptor.js';

const xorKey = 'bla_bla_bla';
const semRequest = new Semaphore(1);
let state = null;

const states = {
  STOPPED: 0,
  LISTEN: 1
};
const stateBadgeTexts = {
  [states.STOPPED]: 'OFF',
  [states.LISTEN]: 'ON'
}

const setState = async (tabId, tabState) => {
  state[tabId] = tabState;
  await chrome.storage.local.set(state);
}

const getBlobUrl = async (blob) => {
  const url = chrome.runtime.getURL('offscreen.html');
  try {
    await chrome.offscreen.createDocument({
      url,
      reasons: [ 'BLOBS' ],
      justification: 'MV3 requirement'
    });
  } catch (err) {
    if (!err.message.startsWith('Only a single offscreen')) throw err;
  }
  const client = (await clients.matchAll({includeUncontrolled: true}))
    .find(c => c.url === url);
  const mc = new MessageChannel();
  client.postMessage(blob, [ mc.port2 ]);
  const res = await new Promise(cb => (mc.port1.onmessage = cb));
  return res.data;
}

chrome.webNavigation.onCommitted.addListener(async (info) => {
  state = await chrome.storage.local.get();
  if (!state[info.tabId]) {
    await setState(info.tabId, states.STOPPED);
  }

  if (state[info.tabId] === states.LISTEN) {
    chrome.webRequest.onBeforeRequest.addListener(requestListener, {urls: [ '<all_urls>' ]}, []);
  }

  await chrome.action.setBadgeText({
    tabId: info.tabId,
    text: stateBadgeTexts[state[info.tabId]]
  });
});

let processedMasterPlaylists = new Set();
let masterPlayList = {
  url: null,
  data: null
};
let obtainedPlaylists = new Set();

const triggerPlaylistObtainProcess = async (tabId, processUrl, masterPlayListLocalUrl, masterPlayListLocalData) => {
  const website = new URL(processUrl).origin;
  if (state[website] === states.STOPPED) {
    return;
  }
  /*
    await chrome.action.setBadgeText({
      tabId: tab.id,
      text: 'DWN'
    });
  */

  const masterPlayListMetaData = m3u8Parser(masterPlayListLocalData, masterPlayListLocalUrl);
  const maxLevel = masterPlayListMetaData.levels.sort((a, b) => b.bandwidth - a.bandwidth)[0];
  const responsePlaylist = await fetch(maxLevel.url);
  const playListWithMaxResolutionData = await responsePlaylist.text();

  let extMediaReady = playListWithMaxResolutionData.substring(playListWithMaxResolutionData.indexOf('#EXT-X-MEDIA-READY'));
  extMediaReady = extMediaReady.substring(0, extMediaReady.indexOf('\n')).replace('#EXT-X-MEDIA-READY:', '').trim();
  const IV = decryptor.computeIV(extMediaReady, xorKey)
  const processedPlayListData = playListWithMaxResolutionData.replace('[KEY]', processUrl).replace('[IV]', `0x${ IV }`);


  const tab = await chrome.tabs.get(tabId);
  const safeTitleName = tab.title.trim().replaceAll(/[\/:\*\?"<>\|]/g, '');

  const playlistUrl = `data:application/vnd.apple.mpegurl;base64,${ btoa(processedPlayListData) }`;
  const playlistFilename = `${ safeTitleName }.m3u8`;
  chrome.downloads.download({
    url: playlistUrl,
    filename: playlistFilename
  });

  const playlist = m3u8Parser(processedPlayListData, maxLevel.url);
  const playlistKeyData = playlist.key[0];
  const keyResponse = await fetch(playlistKeyData.uri);
  const key = await keyResponse.text();
  const filesData = [];

  for (const segment of playlist.segments) {
    console.log(`processing segment ${ segment.sn }`);
    const r = await fetch(segment.url);
    const buffer = await r.arrayBuffer();
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key).buffer, {
      name: 'AES-CBC',
      length: 128
    }, false, [ 'decrypt' ])

    const ivBuffer = new Uint8Array(playlistKeyData.iv.substring(2).match(/[\da-f]{2}/gi).map(function (h) {
      return parseInt(h, 16)
    }));

    const decrypted = await decryptor.decryptAes(buffer, cryptoKey, ivBuffer.buffer);
    filesData.push(decrypted);
  }

  console.log('processed!')

  const videoBlob = await new Blob(filesData, {type: 'application/octet-stream'});
  const videoFilename = `${ safeTitleName }.ts`;

  const videoBlobUrl = await getBlobUrl(videoBlob);
  chrome.downloads.download({url: videoBlobUrl, filename: videoFilename});

  processedMasterPlaylists.add(masterPlayList);
  await chrome.action.setBadgeText({
    tabId: tab.id,
    text: 'ON'
  });
}

const requestListener = async (resp) => {
  await semRequest.acquire();

  if (resp.url.includes('/process/')) {
    await triggerPlaylistObtainProcess(resp.tabId, resp.url, masterPlayList.url, masterPlayList.data);
  }

  const ext = resp.url.split('?')[0].split('#')[0].split('.').pop();
  if (ext === 'm3u8' && !obtainedPlaylists.has(resp.url)) {
    const data = await fetch(resp.url);
    const playlistData = await data.text();
    obtainedPlaylists.add(resp.url);
    if (playlistData.includes('EXT-X-STREAM-INF')) {
      masterPlayList = {
        url: resp.url,
        data: playlistData
      };
    }
  }

  await semRequest.release();
}

chrome.action.onClicked.addListener(async (tab) => {

  if (state[tab.id] === states.STOPPED) {
    await setState(tab.id, states.LISTEN);
    chrome.webRequest.onBeforeRequest.addListener(requestListener, {urls: [ '<all_urls>' ]}, []);

  } else if (state[tab.id] === states.LISTEN) {
    await setState(tab.id, states.STOPPED);
    chrome.webRequest.onBeforeRequest.removeListener(requestListener);
  }

  await chrome.action.setBadgeText({
    tabId: tab.id,
    text: stateBadgeTexts[state[tab.id]]
  });
});

