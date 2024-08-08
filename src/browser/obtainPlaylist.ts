import m3u8Parser from './vendor/m3u8Parser';
import decryptor from './decryptor';
import safeRequest from './safeRequest';
import progressStatus from './progressStatus';

const xorKey = 'bla_bla_bla';

const downloadBlob = (blob: Blob, name: string) => {
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = blobUrl;
  link.download = name;
  document.body.appendChild(link);

  link.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window
    })
  );

  document.body.removeChild(link);
};

const triggerPlaylistObtainProcess = async (
  processUrl: string,
  headers: { [key: string]: string },
  masterPlaylist: { data: string, url: string },
  domProgressBarNode: Node
) => {
  const masterPlayListMetaData: any = m3u8Parser(masterPlaylist.data, masterPlaylist.url);
  const maxLevel = masterPlayListMetaData.levels.sort((a, b) => parseInt(b.bandwidth, 10) - parseInt(a.bandwidth, 10))[0];
  const responsePlaylist = await safeRequest(maxLevel.url, headers);
  const playListWithMaxResolutionData = await responsePlaylist.text();

  let extMediaReady = playListWithMaxResolutionData.substring(playListWithMaxResolutionData.indexOf('#EXT-X-MEDIA-READY'));
  extMediaReady = extMediaReady.substring(0, extMediaReady.indexOf('\n')).replace('#EXT-X-MEDIA-READY:', '').trim();
  const IV = decryptor.computeIV(extMediaReady, xorKey);
  const processedPlayListData = playListWithMaxResolutionData.replace('[KEY]', processUrl).replace('[IV]', `0x${IV}`);

  const safeTitleName = document.title.trim().replaceAll(/[\/:\*\?"<>\|]/g, '');
  const playlistBlob = new Blob([processedPlayListData], { type: 'application/vnd.apple.mpegurl' });
  const playlistFilename = `${safeTitleName}.m3u8`;
  downloadBlob(playlistBlob, playlistFilename);

  const playlist: any = m3u8Parser(processedPlayListData, maxLevel.url);
  const playlistKeyData = playlist.key[0];
  const keyResponse = await safeRequest(playlistKeyData.uri, headers);
  const key = await keyResponse.text();
  const filesData = [];

  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key).buffer, {
    name: 'AES-CBC',
    length: 128
  }, false, ['decrypt']);

  for (const segment of playlist.segments) {
    const progressProcessingText = progressStatus.processingSegment(segment.sn, playlist.segments.length);
    console.log(progressProcessingText);
    domProgressBarNode.textContent = progressProcessingText;

    const r = await safeRequest(segment.url, headers);
    const buffer = await r.arrayBuffer();

    const ivBuffer = new Uint8Array(playlistKeyData.iv.substring(2).match(/[\da-f]{2}/gi).map(function (h) {
      return parseInt(h, 16);
    }));

    const decrypted = await decryptor.decryptAes(buffer, cryptoKey, ivBuffer.buffer);
    filesData.push(decrypted);
  }

  const progressProcessedText = progressStatus.processed();
  console.log(progressProcessedText);
  domProgressBarNode.textContent = progressProcessedText;

  setTimeout(() => {
    domProgressBarNode.textContent = progressStatus.awaiting();
  }, 2000);


  const videoBlob = new Blob(filesData, { type: 'application/octet-stream' });
  const videoFilename = `${safeTitleName}.ts`;

  downloadBlob(videoBlob, videoFilename);
};

export default triggerPlaylistObtainProcess;

