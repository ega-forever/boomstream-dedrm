import safeRequest from './safeRequest';
import triggerPlaylistObtainProcess from './obtainPlaylist';
import Semaphore from './vendor/semaphore';
import progressStatus from './progressStatus';

declare const chrome: any;


let masterPlaylist = null;
const sem = new Semaphore(1);

const createProgressBar = () => {
  const progressBarId = 'dedrm-progress-bar';
  const elem = document.getElementById(progressBarId);

  if (elem) {
    return elem;
  }

  const progressBarP = document.createElement('p');
  Object.assign(progressBarP.style, {
    position: 'absolute',
    backgroundColor: '#ffa500',
    width: '100%',
    textAlign: 'center',
    height: '50px',
    color: '#000',
    fontSize: '20px'
  });
  progressBarP.id = 'progressBarId';
  progressBarP.textContent = progressStatus.awaiting();

  document.body.appendChild(progressBarP);
  progressBarP.focus();
  return progressBarP;
};

const domElement = createProgressBar();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  void (async () => {
    await sem.acquire();
    try {
      if (request.url.includes('/process/') && masterPlaylist) {
        await triggerPlaylistObtainProcess(request.url, request.headers, masterPlaylist, domElement);
        masterPlaylist = null;
      }

      const ext = request.url.split('?')[0].split('#')[0].split('.').pop();
      if (ext === 'm3u8' && !masterPlaylist) {
        const data = await safeRequest(request.url, request.headers);
        const playlistData = await data.text();
        if (playlistData.includes('EXT-X-STREAM-INF')) {
          masterPlaylist = {
            url: request.url,
            data: playlistData
          };
        }
      }
    } catch (error) {
      console.error('Boomstream download failed', error);
      domElement.textContent = `Download failed: ${error.message}`;
    } finally {
      sem.release();
      sendResponse({}); // call after request processed
    }
  })();
  return true;
});
