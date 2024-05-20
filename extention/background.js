import computeIV from './decryptor.js';
import Semaphore from './semaphore.js';
import m3u8Parser from './vendor/m3u8Parser.js';
import videoDecryptor from './videoDecryptor.js';

const xorKey = 'bla_bla_bla';
const sem = new Semaphore(1);


chrome.action.onClicked.addListener(async (tab) => {
  /*if (tab.url.startsWith(extensions) || tab.url.startsWith(webstore)) {
    // We retrieve the action badge to check if the extension is 'ON' or 'OFF'
    const prevState = await chrome.action.getBadgeText({ tabId: tab.id });
    // Next state will always be the opposite
    const nextState = prevState === 'ON' ? 'OFF' : 'ON';

    // Set the action badge to the next state
    await chrome.action.setBadgeText({
      tabId: tab.id,
      text: nextState
    });

    if (nextState === 'ON') {
      // Insert the CSS file when the user turns the extension on
      await chrome.scripting.insertCSS({
        files: ['focus-mode.css'],
        target: { tabId: tab.id }
      });
    } else if (nextState === 'OFF') {
      // Remove the CSS file when the user turns the extension off
      await chrome.scripting.removeCSS({
        files: ['focus-mode.css'],
        target: { tabId: tab.id }
      });
    }
  }*/

  //current uri and masterPlaylists (last seen via requests)
  let uri;
  let masterPlayList = {
    url: null,
    data: null
  };

  let obtainedPlaylists = new Set();
  let processedMasterPlaylists = new Set();

  const triggerPlaylistObtainProcess = async (uriLocal, masterPlayListLocalUrl, masterPlayListLocalData) => {

    await sem.acquire();

    if (!uriLocal || !masterPlayListLocalUrl || processedMasterPlaylists.has(masterPlayList)) {
      await sem.release();
      return
    }

    const masterPlayListMetaData = m3u8Parser(masterPlayListLocalData, masterPlayListLocalUrl);
    const maxLevel = masterPlayListMetaData.levels.sort((a, b) => b.bandwidth - a.bandwidth)[0];
    const responsePlaylist = await fetch(maxLevel.url);
    const playListWithMaxResolutionData = await responsePlaylist.text();

    let extMediaReady = playListWithMaxResolutionData.substring(playListWithMaxResolutionData.indexOf('#EXT-X-MEDIA-READY'));
    extMediaReady = extMediaReady.substring(0, extMediaReady.indexOf('\n')).replace('#EXT-X-MEDIA-READY:', '').trim();
    const IV = computeIV(extMediaReady, xorKey)
    const processedPlayListData = playListWithMaxResolutionData.replace('[KEY]', uri).replace('[IV]', `0x${ IV }`);

    const playlistUrl = `data:application/vnd.apple.mpegurl;base64,${ btoa(processedPlayListData) }`;
    const playlistFilename = `${ tab.title }.m3u8`;
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

      const decrypted = await videoDecryptor(buffer, cryptoKey, ivBuffer.buffer);
      filesData.push(decrypted);
    }

    console.log('processed!')

    const videoBlob = await new Blob(filesData);
    const videoFilename = `${ tab.title }.ts`;

    await chrome.downloads.download({
      url: URL.createObjectURL(videoBlob),
      filename: videoFilename
    });


    processedMasterPlaylists.add(masterPlayList);
    await sem.release();
  }

  chrome.webRequest.onBeforeRequest.addListener(
    async (resp) => {
      if (resp.url.includes('/process/')) {
        uri = resp.url;
        await triggerPlaylistObtainProcess(uri, masterPlayList.url, masterPlayList.data);
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
          await triggerPlaylistObtainProcess(uri, masterPlayList.url, masterPlayList.data);
        }
      }

    }, {urls: [ '<all_urls>' ]}, [])
});

