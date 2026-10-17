"use strict";

window.SCDL__CLIENT_ID = null;
window.SCDL__LAST_URL = null;
window.SCDL__NB_CLASSIC_BUTTON_GROUPS = 0;
window.SCDL__NB_MUI_MENU_BUTTONS = 0;
window.SCDL__DOM_ELEMENTS = [];
window.SCDL__TOAST_ELEMENT = null;
window.SCDL__TOAST_TIMEOUT = null;
window.SCDL__TOAST_NOTICE_TIMEOUT = null;
window.SCDL__DOWNLOADING_BUTTON = null;

/**
 * Label for the frame this code runs in: "top frame" or "iframe".
 * Every frame the content script is injected into runs its own copy of
 * this script, so watchNewTracksInterval and setClientId each run once
 * per frame. The logs say which frame they came from.
 * @returns {string}
 */
const getFrameLabel = () => (window.top === window ? "top frame" : "iframe");

/**
 * Define custom logger object for logging
 * with a prefixed tag to differenciate add-on logs.
 */
const SCDL_LOG_PREFIX = "[scdl]";
const logger = {
  info: console.info.bind(console, SCDL_LOG_PREFIX, `(${getFrameLabel()})`),
  error: console.error.bind(console, SCDL_LOG_PREFIX, `(${getFrameLabel()})`),
};

const sanitizeFilename = (filename) => {
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

/**
 * Check every second for new loaded tracks in the page.
 * Add download button if the page url has changed, or if new tracks
 * have been loaded in the page.
 */
const watchNewTracksInterval = setInterval(() => {
  try {
    if (isThirdPartyEmbed()) return;

    const pageUrl = document.URL;
    const pageButtonGroups = document.getElementsByClassName("sc-button-group");
    const muiMenuButtons = document.querySelectorAll(MUI_MENU_TRIGGER_SELECTOR);

    if (
      window.SCDL__CLIENT_ID &&
      (pageUrl !== window.SCDL__LAST_URL ||
        pageButtonGroups.length !== window.SCDL__NB_CLASSIC_BUTTON_GROUPS ||
        muiMenuButtons.length !== window.SCDL__NB_MUI_MENU_BUTTONS)
    ) {
      insertDownloadButtons();
      insertMuiDownloadButtons();
      window.SCDL__LAST_URL = pageUrl;
      window.SCDL__NB_CLASSIC_BUTTON_GROUPS = pageButtonGroups.length;
      window.SCDL__NB_MUI_MENU_BUTTONS = muiMenuButtons.length;
    }
  } catch (err) {
    logger.error(err);
  }
}, 1000);

/**
 * Stop the interval when the user navigates away from the page
 */
window.addEventListener("beforeunload", () => {
  clearInterval(watchNewTracksInterval);
});

/**
 * Write metadatas to track buffer, then save it as mp3 file.
 * This is using ID3 version 2.3 (ID3v2.3) tags supported by browser-id3-writer.
 * @see https://github.com/egoroof/browser-id3-writer?tab=readme-ov-file#supported-frames
 * @param {ArrayBuffer} trackBuffer
 * @param {ArrayBuffer} artworkBuffer
 * @param {object} metadata
 */
const tagAndSaveTrack = async (trackBuffer, artworkBuffer, metadata) => {
  const writer = new ID3Writer(trackBuffer);

  const songArtist =
    metadata.publisher_metadata?.artist || metadata.user?.username;

  if (songArtist) {
    writer.setFrame("TPE1", [songArtist]);
  }

  const songTitle =
    metadata.publisher_metadata?.release_title || metadata.title;

  if (songTitle) {
    writer.setFrame("TIT2", songTitle);
  }

  // keep only year from date
  const albumReleaseYear =
    metadata.release_date || metadata.created_at?.split("-")?.[0];

  if (albumReleaseYear) {
    writer.setFrame("TYER", albumReleaseYear);
  }

  const songGenre = metadata.genre;

  if (songGenre) {
    writer.setFrame("TCON", [songGenre]);
  }

  const songComposer = metadata.publisher_metadata?.writer_composer;

  if (songComposer) {
    writer.setFrame("TCOM", [songComposer]);
  }

  const sourceWebpage = metadata.permalink_url;

  if (sourceWebpage) {
    writer.setFrame("WOAS", sourceWebpage);
  }

  if (artworkBuffer) {
    writer.setFrame("APIC", {
      type: 3,
      data: artworkBuffer,
      description: "Track artwork",
    });
  }

  const songDescription = metadata.description;

  if (songDescription) {
    writer.setFrame("COMM", {
      description: "",
      text: songDescription,
    });
  }

  writer.addTag();

  let settings;
  try {
    settings = await browser.storage.sync.get(SCDL__FORMAT_DEFAULTS);
  } catch (err) {
    logger.error("Failed to read settings, using defaults.", err);
    settings = SCDL__FORMAT_DEFAULTS;
  }

  const tokenData = {
    artist: songArtist || "",
    title: songTitle || "",
    year: albumReleaseYear || "",
    genre: songGenre || "",
    album: metadata.publisher_metadata?.album_title || "",
    username: metadata.user?.username || "",
    comment: songDescription || "",
  };

  let filename = applyFormat(settings.format, tokenData);

  if (settings.lowercase) {
    filename = filename.toLowerCase();
  }

  filename = sanitizeFilename(filename) || "untitled";

  saveAs(writer.getBlob(), `${filename}.mp3`);
};

/**
 * Fetch an HLS playlist and its media segments, and join them into one
 * buffer, in play order.
 *
 * In an HLS playlist, lines starting with "#" are tags (#EXTINF...),
 * and every other non-empty line is a media segment's URI. An
 * EXT-X-MAP tag names an init segment, which goes first: for fragmented
 * MP4, it holds the moov box the decoder needs. trim() also drops the
 * "\r" of CRLF line endings.
 * @param {string} playlistUrl
 * @param {(url: string) => Promise<Response>} fetchUrl the add-on's own
 *   fetch, or the page's (content.fetch) for a CDN outside its permissions
 * @returns {Promise<ArrayBuffer>}
 */
const fetchHlsMedia = async (playlistUrl, fetchUrl) => {
  const playlistRes = await fetchUrl(playlistUrl);

  if (playlistRes.status !== 200) {
    throw new Error("Error while fetching 'hls' track URL...");
  }

  const playlist = await playlistRes.text();
  const initUri = playlist.match(/#EXT-X-MAP:.*URI="([^"]+)"/)?.[1];
  const segmentUris = playlist
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const segmentBuffers = await Promise.all(
    [initUri, ...segmentUris].filter(Boolean).map(async (uri) => {
      const segmentRes = await fetchUrl(new URL(uri, playlistUrl).toString());

      if (segmentRes.status !== 200) {
        throw new Error("Error while fetching 'hls' track segment...");
      }

      return segmentRes.arrayBuffer();
    })
  );

  return new Blob(segmentBuffers).arrayBuffer();
};

/**
 * Resolve track with an mp3 'hls' transcoding.
 * @param {string} trackUrl
 * @param {ArrayBuffer} artworkBuffer
 * @param {object} metadata
 */
const resolveHlsBuffer = async (trackUrl, artworkBuffer, metadata) => {
  const trackBuffer = await fetchHlsMedia(trackUrl, (url) => fetch(url));

  await tagAndSaveTrack(trackBuffer, artworkBuffer, metadata);
};

/**
 * Resolve track with 'progressive' transcoding format.
 * @param {string} trackUrl
 * @param {ArrayBuffer} artworkBuffer
 * @param {object} metadata
 */
const resolveProgressiveBuffer = async (trackUrl, artworkBuffer, metadata) => {
  const trackRes = await fetch(trackUrl);

  if (trackRes.status !== 200) {
    throw new Error("Error while fetching 'progressive' track URL...");
  }

  const trackBuffer = await trackRes.arrayBuffer();

  await tagAndSaveTrack(trackBuffer, artworkBuffer, metadata);
};

/**
 * Bitrate of the mp3 encoded from an AAC stream. SoundCloud's AAC is
 * 160 kbps at most, so a higher mp3 bitrate adds no quality back. It
 * keeps the loss from encoding a second time as low as possible.
 */
const MP3_ENCODE_BITRATE_KBPS = 320;

/**
 * Samples per channel handed to the mp3 encoder per call, 16 mp3
 * frames of 1152 samples. The page runs between calls, so this sets how
 * long it stays blocked: about 30 ms per call.
 */
const MP3_ENCODE_CHUNK_SAMPLES = 1152 * 16;

/**
 * Let the page handle its pending events before going on. Not a
 * setTimeout: timers are throttled to once a second in background tabs,
 * which would stretch the encoding to minutes if the user switches tabs.
 * A MessageChannel message is not a timer.
 * @returns {Promise<void>}
 */
const yieldToPage = () =>
  new Promise((resolve) => {
    const channel = new MessageChannel();

    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });

/**
 * Encode decoded audio to mp3 with lamejs, one chunk at a time.
 *
 * Samples are copied out with copyFromChannel rather than read from
 * getChannelData: the AudioBuffer belongs to the page, and reading a
 * page-owned array element by element from a content script goes
 * through Firefox's Xray wrappers on every access.
 * @param {AudioBuffer} audioBuffer
 * @param {(ratio: number) => void} onProgress
 * @returns {Promise<ArrayBuffer>}
 */
const encodeMp3 = async (audioBuffer, onProgress) => {
  // mp3 holds one or two channels: a mono track stays mono, anything
  // wider keeps its first two
  const channelCount = Math.min(audioBuffer.numberOfChannels, 2);
  // the encoder, set to the track's sample rate and the target bitrate
  const encoder = new lamejs.Mp3Encoder(
    channelCount,
    audioBuffer.sampleRate,
    MP3_ENCODE_BITRATE_KBPS
  );
  // buffers reused for every chunk: one for the samples copied out of
  // the decoded audio, as floats from -1 to 1, and one per channel for
  // the same samples as the 16-bit integers lamejs takes
  const floatChunk = new Float32Array(MP3_ENCODE_CHUNK_SAMPLES);
  const pcmChunks = Array.from(
    { length: channelCount },
    () => new Int16Array(MP3_ENCODE_CHUNK_SAMPLES)
  );
  // the mp3 bytes, in the order the encoder hands them back
  const mp3Parts = [];

  // walk through the track one chunk at a time
  for (
    let offset = 0;
    offset < audioBuffer.length;
    offset += MP3_ENCODE_CHUNK_SAMPLES
  ) {
    // every chunk is full except usually the last one: the views cover
    // just this chunk's samples
    const size = Math.min(
      MP3_ENCODE_CHUNK_SAMPLES,
      audioBuffer.length - offset
    );
    const samples = floatChunk.subarray(0, size);
    const pcm = pcmChunks.map((chunk) => chunk.subarray(0, size));

    // for each channel, copy this chunk's samples, then convert them
    for (let channel = 0; channel < channelCount; channel++) {
      const channelPcm = pcm[channel];

      audioBuffer.copyFromChannel(samples, channel, offset);

      // float to 16-bit integer: -1..1 becomes -32767..32767. A sample
      // past -1 or 1 is clamped first, so it can't wrap around
      for (let i = 0; i < size; i++) {
        const sample = samples[i];

        channelPcm[i] = (sample < -1 ? -1 : sample > 1 ? 1 : sample) * 0x7fff;
      }
    }

    // encode the chunk. lamejs can return fewer bytes than expected, or
    // none: it holds samples back until it has whole mp3 frames
    mp3Parts.push(encoder.encodeBuffer(...pcm));

    onProgress((offset + size) / audioBuffer.length);

    // let the page handle clicks, scrolling and playback before the
    // next chunk
    await yieldToPage();
  }

  // write out the samples the encoder still holds: the end of the track
  mp3Parts.push(encoder.flush());

  // join the parts into one mp3 file
  return new Blob(mp3Parts).arrayBuffer();
};

/**
 * Resolve track with an AAC 'hls' transcoding: fetch its segments,
 * decode the joined file (fragmented MP4) with the browser's own AAC
 * decoder, then encode it to mp3.
 * @param {string} playlistUrl
 * @param {ArrayBuffer} artworkBuffer
 * @param {object} metadata
 * @param {(message: string, percent?: number) => void} onProgress
 */
const resolveAacHlsBuffer = async (
  playlistUrl,
  artworkBuffer,
  metadata,
  onProgress
) => {
  const title = shortenTitle(metadata.title || "track");

  onProgress(`Downloading “${title}”…`);

  // fetched the way the page itself does. The CDN only sends CORS
  // headers when the request carries an Origin header. In Firefox MV2,
  // the content script's own fetch sends none, and the CDN's domain
  // isn't in the add-on's permissions, so Firefox blocks the response
  // with a NetworkError. content.fetch sends the request as the page
  // would, with its Origin
  const aacBuffer = await fetchHlsMedia(playlistUrl, (url) =>
    content.fetch(url)
  );

  onProgress(`Decoding “${title}”…`);

  let audioBuffer;
  try {
    // decodeAudioData is a method of an audio context. An offline one
    // never plays anything, and only its sample rate matters here:
    // decodeAudioData resamples to it, and 44100 Hz is the rate of the
    // AAC streams checked, so nothing gets resampled. The 2 channels and
    // the 1-frame length are for rendering, which never runs
    audioBuffer = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(
      aacBuffer
    );
  } catch (err) {
    logger.error(err);
    throw new Error("Your browser couldn't decode this track's AAC stream.");
  }

  let lastPercent;
  const mp3Buffer = await encodeMp3(audioBuffer, (ratio) => {
    const percent = Math.floor(ratio * 100);

    if (percent !== lastPercent) {
      lastPercent = percent;
      onProgress(`Converting “${title}” to mp3… ${percent}%`, percent);
    }
  });

  await tagAndSaveTrack(mp3Buffer, artworkBuffer, metadata);
};

/**
 * Resolve track artwork URL (or user avatar URL) to an ArrayBuffer.
 * @param {string} artworkUrl
 * @returns {Promise<ArrayBuffer>}
 */
const resolveArtworkBuffer = async (artworkUrl) => {
  if (!artworkUrl) return;

  const artworkRes = await fetch(artworkUrl.replace(/large/gi, "t500x500"));

  if (artworkRes.status !== 200) {
    throw new Error("Error while fetching artwork URL...");
  }

  return artworkRes.arrayBuffer();
};

/**
 * User-facing message for both DRM failure paths in fetchStreamData:
 * either no candidate transcoding was ever advertised, or candidates
 * existed and every endpoint 404'd. The user reads the same message for
 * both, since the outcome is the same. The logs keep the distinction.
 */
const DRM_ERROR_MESSAGE =
  "This track is now copy-protected by SoundCloud (like a Netflix show or Spotify song) and can't be downloaded :(";

/**
 * True for the format of an unencrypted HLS transcoding of AAC in
 * fragmented MP4 (mime type `audio/mp4; codecs="mp4a.40.2"`).
 * @param {{protocol?: string, mime_type?: string}} format
 * @returns {boolean}
 */
const isAacHlsFormat = (format) =>
  format?.protocol === "hls" && format?.mime_type?.startsWith("audio/mp4");

/**
 * Bitrate in kbps read from an AAC transcoding's preset ("aac_160k"),
 * or 0 when the preset doesn't give one.
 * @param {object} transcoding
 * @returns {number}
 */
const getAacPresetBitrate = (transcoding) =>
  Number(transcoding.preset?.match(/^aac_(\d+)k$/)?.[1]) || 0;

/**
 * Find a working transcoding for the track and return its data.
 * @param {object[]} transcodings
 * @returns {Promise<any>}
 */
const fetchStreamData = async (transcodings) => {
  // keep only 'audio/mpeg' mime types
  // & prioritizes 'progressive' transcoding format
  const mp3Transcodings = transcodings.reduce((acc, t) => {
    if (t.format.mime_type === "audio/mpeg") {
      if (t.format.protocol === "progressive") {
        acc.unshift(t);
      } else {
        acc.push(t);
      }
    }

    return acc;
  }, []);

  // soundcloud no longer serves mp3 for most tracks, only AAC over HLS.
  // AAC comes after mp3, highest bitrate first: it has to be re-encoded
  // to mp3, which costs time and some quality.
  const aacTranscodings = transcodings
    .filter((t) => isAacHlsFormat(t.format))
    .sort((a, b) => getAacPresetBitrate(b) - getAacPresetBitrate(a));

  const filteredTranscodings = [...mp3Transcodings, ...aacTranscodings];

  // soundcloud advertises encrypted-only transcodings for DRM-protected
  // tracks; no unencrypted stream is ever offered for those.
  const hasEncryptedTranscoding = transcodings.some((t) =>
    t.format?.protocol?.includes("encrypted")
  );

  if (filteredTranscodings.length === 0) {
    throw new Error(
      hasEncryptedTranscoding
        ? DRM_ERROR_MESSAGE
        : "No supported transcoding found for this track."
    );
  }

  for (const transcoding of filteredTranscodings) {
    logger.info(
      `Trying with '${transcoding.format?.protocol}' transcoding ('${transcoding.format?.mime_type}' MIME type)...`
    );

    const streamUrl = new URL(transcoding.url);

    streamUrl.searchParams.set("client_id", window.SCDL__CLIENT_ID);

    const streamRes = await fetch(streamUrl.toString());

    if (streamRes.status === 200) {
      const streamData = await streamRes.json();

      return { ...streamData, ...transcoding.format };
    }

    logger.info(
      `→ '${transcoding.format?.protocol}' returned HTTP ${streamRes.status}`
    );
  }

  // unencrypted transcodings advertised but every endpoint 404'd:
  // soundcloud is dropping unencrypted streams for tracks moved under DRM
  if (hasEncryptedTranscoding) {
    logger.error(
      "SoundCloud no longer serves an unencrypted stream for this track (all non-encrypted transcoding endpoints returned non-200)."
    );
  }

  throw new Error(
    hasEncryptedTranscoding
      ? DRM_ERROR_MESSAGE
      : "All transcoding endpoints failed (track may be region-locked or removed)."
  );
};

/**
 * Resolve track metadata for download.
 * @param {string} url
 * @returns {Promise<any>}
 */
const resolveTrack = async (url) => {
  const resolveUrl = new URL("https://api-v2.soundcloud.com");

  resolveUrl.pathname = "resolve";
  resolveUrl.searchParams.set("url", url);
  resolveUrl.searchParams.set("client_id", window.SCDL__CLIENT_ID);

  const resolveRes = await fetch(resolveUrl.toString());

  if (resolveRes.status !== 200) {
    throw new Error(`Error while resolving '${url}'...`);
  }

  const resolveData = await resolveRes.json();

  // Only a track carries media.transcodings. Should a download button
  // ever land on a playlist or profile header, this check is what turns
  // the failure into a readable message. Without it, fetchStreamData
  // throws a TypeError and the error toast shows that to the user.
  if (resolveData?.kind !== "track") {
    throw new Error(
      `This isn't a track, so there's nothing to download (SoundCloud resolved it as "${
        resolveData?.kind || "unknown"
      }").`
    );
  }

  return resolveData;
};

/**
 * Checks whether the given link is valid or not
 * @param {HTMLAnchorElement} link
 * @returns {boolean}
 */
const isValidLink = (link) => {
  if (!link?.href) return false;

  const validClassNames = [
    "trackItem__trackTitle",
    "soundTitle__title",
    "chartTrack__title",
    "playableTile__mainHeading",
  ];

  if (
    !validClassNames.some((className) => link.className?.includes(className))
  ) {
    return false;
  }

  const ignoredPaths = ["/stream", "/comments"];

  return !ignoredPaths.some((path) => link.href.includes(path));
};

/**
 * Get URL of the track linked to the download button.
 * @param {HTMLAnchorElement} buttonElement
 * @returns {string}
 */
const getTrackURL = (buttonElement) => {
  const node = [".streamContext", ".chartTrack", ".trackItem"]
    .map((selector) => buttonElement.closest(selector))
    .find(Boolean);

  if (!node) {
    // Safe without a try/catch: getTrackURL is only ever reached via a
    // click handler on a button that watchNewTracksInterval only inserts
    // after isThirdPartyEmbed() has already confirmed window.top is
    // accessible and on soundcloud.com.
    //
    // The query string goes, the path stays. A track shared through a
    // secret link carries its token as a path segment
    // (/<user>/<track>/s-XXXXXX), and that segment is what makes the
    // resolve call return a private track.
    const pageUrl =
      window.top !== window ? window.top.location.href : document.URL;

    return pageUrl.split("?")[0];
  }

  const links = node.querySelectorAll("a");
  const longestValidLink = Array.from(links).reduce(
    (acc, link) =>
      isValidLink(link) && link.href.length > acc.href.length ? link : acc,
    { href: "" }
  );

  if (!longestValidLink.href) {
    throw new Error("Failed to find track URL...");
  }

  const trackURL = longestValidLink.href.split("?")[0];

  return trackURL.startsWith("https://soundcloud.com")
    ? trackURL
    : "https://soundcloud.com" + trackURL;
};

/**
 * Shared "error" red: the toast's and the download button's background
 * on an error, the refused button's flash, and the notice's text, so
 * they all read as the same state.
 */
const ERROR_COLOR = "#ff0000";

/**
 * Background of the toast while a track is being converted.
 */
const PROGRESS_BACKGROUND_COLOR = "#333";

/**
 * Get the single shared toast element, creating and appending it to the
 * page on first use. One element is reused for every message, so a
 * second message while the first is still showing replaces it instead
 * of stacking a duplicate on screen.
 * @returns {HTMLElement}
 */
const getToastElement = () => {
  if (window.SCDL__TOAST_ELEMENT) {
    return window.SCDL__TOAST_ELEMENT;
  }

  const toast = document.createElement("div");

  toast.style.display = "none";
  toast.style.position = "fixed";
  toast.style.bottom = "24px";
  toast.style.right = "24px";
  toast.style.zIndex = "999999";
  toast.style.maxWidth = "320px";
  toast.style.padding = "12px 16px";
  toast.style.borderRadius = "6px";
  toast.style.backgroundColor = ERROR_COLOR;
  toast.style.color = "#fff";
  toast.style.fontSize = "14px";
  toast.style.fontFamily = "sans-serif";
  toast.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.4)";

  const messageElement = document.createElement("div");
  const noticeElement = document.createElement("div");

  noticeElement.style.display = "none";
  noticeElement.style.marginTop = "4px";
  noticeElement.style.fontSize = "12px";
  noticeElement.style.color = ERROR_COLOR;

  toast.append(messageElement, noticeElement);
  toast._scdlMessageElement = messageElement;
  toast._scdlNoticeElement = noticeElement;

  document.body.appendChild(toast);
  window.SCDL__TOAST_ELEMENT = toast;

  return toast;
};

/**
 * Show the given message in the shared error toast for 5 seconds. A
 * repeat call restarts that timer rather than stacking a second one.
 * @param {string} message
 */
const showErrorToast = (message) => {
  const toast = getToastElement();

  hideToastNotice();

  toast._scdlMessageElement.textContent = message;
  toast.style.backgroundColor = ERROR_COLOR;
  toast.style.display = "block";
  toast._scdlIsProgress = false;

  clearTimeout(window.SCDL__TOAST_TIMEOUT);
  window.SCDL__TOAST_TIMEOUT = setTimeout(() => {
    toast.style.display = "none";
  }, 5000);
};

/**
 * Show the given progress message in the shared toast until
 * hideProgressToast is called or an error replaces it.
 * @param {string} message
 */
const showProgressToast = (message) => {
  const toast = getToastElement();

  clearTimeout(window.SCDL__TOAST_TIMEOUT);

  toast._scdlMessageElement.textContent = message;
  toast.style.backgroundColor = PROGRESS_BACKGROUND_COLOR;
  toast.style.display = "block";
  toast._scdlIsProgress = true;
};

/**
 * Hide the shared toast if it shows a progress message. An error shown
 * since stays up for its own 5 seconds.
 */
const hideProgressToast = () => {
  const toast = window.SCDL__TOAST_ELEMENT;

  if (toast?._scdlIsProgress) {
    hideToastNotice();
    toast.style.display = "none";
    toast._scdlIsProgress = false;
  }
};

/**
 * Show a notice under the progress message for 3 seconds. The progress
 * message is rewritten several times a second, so a notice in its place
 * would be overwritten at once.
 *
 * Does nothing when no progress message is showing: there is no line
 * to put the notice under.
 * @param {string} message
 */
const showToastNotice = (message) => {
  const toast = window.SCDL__TOAST_ELEMENT;

  if (!toast?._scdlIsProgress) return;

  const notice = toast._scdlNoticeElement;

  notice.textContent = message;
  notice.style.display = "block";

  clearTimeout(window.SCDL__TOAST_NOTICE_TIMEOUT);
  window.SCDL__TOAST_NOTICE_TIMEOUT = setTimeout(hideToastNotice, 3000);
};

/**
 * Hide the notice under the toast's message, if one is showing.
 */
const hideToastNotice = () => {
  const notice = window.SCDL__TOAST_ELEMENT?._scdlNoticeElement;

  clearTimeout(window.SCDL__TOAST_NOTICE_TIMEOUT);

  if (notice) {
    notice.style.display = "none";
  }
};

/**
 * Shorten a track title for the progress messages: titles on
 * SoundCloud run long, and the toast is 320 px wide.
 * @param {string} title
 * @returns {string}
 */
const shortenTitle = (title) =>
  title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title;

/**
 * Colors of a download button while its track downloads: the button
 * turns dark grey, fills with green from the left as the conversion
 * runs, and its icon turns white, which reads on both. The same on the
 * classic and MUI buttons, whose own colors differ.
 */
const BUTTON_PROGRESS_DONE_COLOR = "#16a34a";
const BUTTON_PROGRESS_ICON_COLOR = "#fff";

/**
 * Show a track's progress on its own download button: the message as
 * the button's tooltip, and, when percent (0 to 100) is given, a green
 * fill from the left over a dark grey background.
 * @param {HTMLElement} button
 * @param {string} message
 * @param {number} [percent]
 */
const setButtonProgress = (button, message, percent) => {
  if (button._scdlProgressIdleTitle === undefined) {
    button._scdlProgressIdleTitle = button.title;
    button._scdlProgressIdleColor = button.style.color;
  }

  button.title = message;

  if (percent !== undefined) {
    button.style.backgroundImage = `linear-gradient(to right, ${BUTTON_PROGRESS_DONE_COLOR} ${percent}%, ${PROGRESS_BACKGROUND_COLOR} ${percent}%)`;
    button.style.color = BUTTON_PROGRESS_ICON_COLOR;
  }
};

/**
 * Remove the progress from a download button: the fill, and the icon
 * color and tooltip, which get back what they were before the download.
 * @param {HTMLElement} button
 */
const clearButtonProgress = (button) => {
  if (button._scdlProgressIdleTitle !== undefined) {
    button.title = button._scdlProgressIdleTitle;
    button.style.color = button._scdlProgressIdleColor;
    button._scdlProgressIdleTitle = undefined;
  }

  button.style.backgroundImage = "";
};

/**
 * How long a download button whose click was refused takes to fade
 * from red back to its own colors.
 */
const REFUSED_CLICK_FADE_MS = 2000;

/**
 * Turn a download button red, then fade it back to its own colors: its
 * click was refused because another track is downloading. A new click
 * during the fade starts it again.
 * @param {HTMLElement} button
 */
const flashRefusedButton = (button) => {
  clearTimeout(button._scdlFlashTimeout);

  if (button._scdlFlashIdleState === undefined) {
    button._scdlFlashIdleState = {
      backgroundColor: button.style.backgroundColor,
      color: button.style.color,
    };
  }

  const idleState = button._scdlFlashIdleState;

  // switch to red with no transition, and make the browser apply it
  // (reading offsetWidth does), so the fade below starts from red
  button.style.transition = "none";
  button.style.backgroundColor = ERROR_COLOR;
  button.style.color = "#fff";
  void button.offsetWidth;

  button.style.transition = `background-color ${REFUSED_CLICK_FADE_MS}ms ease-out, color ${REFUSED_CLICK_FADE_MS}ms ease-out`;
  button.style.backgroundColor = idleState.backgroundColor;
  button.style.color = idleState.color;

  button._scdlFlashTimeout = setTimeout(() => {
    button.style.transition = "";
    button._scdlFlashIdleState = undefined;
  }, REFUSED_CLICK_FADE_MS);
};

/**
 * Briefly turn the download button red and surface the error message via
 * its title attribute and a screen-corner toast (so it's visible without
 * hovering). Clears any pending reset so rapid clicks don't cause the
 * button to revert to its normal state mid-error.
 *
 * The button's backgroundColor, color and title are captured before the
 * first error and put back afterwards, once, not again on repeat clicks
 * while the button is already red. Restoring the captured values is
 * what the MUI button needs, since it has an idle inline background
 * color and title of its own.
 * @param {HTMLElement} button
 * @param {string} message
 */
const showDownloadErrorFeedback = (button, message) => {
  showErrorToast(message);

  if (button._scdlResetTimeout) {
    clearTimeout(button._scdlResetTimeout);
  } else {
    button._scdlIdleState = {
      backgroundColor: button.style.backgroundColor,
      color: button.style.color,
      title: button.title,
    };
  }

  button.title = message;
  button.style.backgroundColor = ERROR_COLOR;
  button.style.color = "#fff";

  button._scdlResetTimeout = setTimeout(() => {
    button.style.backgroundColor = button._scdlIdleState.backgroundColor;
    button.style.color = button._scdlIdleState.color;
    button.title = button._scdlIdleState.title;
    button._scdlResetTimeout = null;
  }, 5000);
};

/**
 * Add the session's client_id to a stream URL, as SoundCloud's mp3
 * endpoints require. Not for the AAC playlist URL: it is signed, and
 * the CDN answers 403 once a query parameter is added to it.
 * @param {string} url
 * @returns {string}
 */
const withClientId = (url) => {
  const streamUrl = new URL(url);

  streamUrl.searchParams.set("client_id", window.SCDL__CLIENT_ID);

  return streamUrl.toString();
};

/**
 * Get track URL, resolve its metadata, tag and save as .mp3 file.
 * @param {HTMLElement} buttonElement
 */
const downloadTrack = async (buttonElement) => {
  const trackURL = getTrackURL(buttonElement);
  const resolveData = await resolveTrack(trackURL);
  const streamData = await fetchStreamData(resolveData?.media?.transcodings);

  let artworkBuffer;
  try {
    artworkBuffer = await resolveArtworkBuffer(
      resolveData?.artwork_url || resolveData?.user?.avatar_url
    );
  } catch (err) {
    logger.error(err);
  }

  if (streamData.protocol === "progressive") {
    await resolveProgressiveBuffer(
      withClientId(streamData.url),
      artworkBuffer,
      resolveData
    );
  } else if (isAacHlsFormat(streamData)) {
    await resolveAacHlsBuffer(
      streamData.url,
      artworkBuffer,
      resolveData,
      (message, percent) => {
        showProgressToast(message);
        setButtonProgress(buttonElement, message, percent);
      }
    );
  } else if (streamData.protocol === "hls") {
    await resolveHlsBuffer(
      withClientId(streamData.url),
      artworkBuffer,
      resolveData
    );
  } else {
    throw new Error("Failed to resolve track: Unknown protocol.");
  }
};

/**
 * Wire up a download button's click handler: run downloadTrack, and on
 * failure log the error and flash the button red via showDownloadErrorFeedback.
 * One download runs at a time. While one is running, a click on another
 * track's button is ignored: the button flashes red and a notice under
 * the progress says so. A click on the button of the track downloading
 * does nothing.
 * Two downloads at once would write their progress over each other in
 * the one toast. And Firefox cancels a download when the site already
 * started one without a recent click (IsDownloadSpam in Firefox's
 * nsExternalHelperAppService.cpp), which is the case here: the file is
 * saved long after the click, once converted.
 *
 * The lock is per frame, as every frame runs its own copy of this
 * script.
 * Shared by both the classic and MUI insertion paths.
 * @param {HTMLElement} button
 */
const attachDownloadClickHandler = (button) => {
  button.addEventListener(
    "click",
    async () => {
      const downloadingButton = window.SCDL__DOWNLOADING_BUTTON;

      if (downloadingButton) {
        if (downloadingButton !== button) {
          flashRefusedButton(button);
          showToastNotice("Another download is in progress.");
        }

        return;
      }

      window.SCDL__DOWNLOADING_BUTTON = button;

      // shown at once, before the SoundCloud API calls, so the click
      // gets an answer and a second click has a line to put its notice
      // under
      showProgressToast("Downloading track…");
      setButtonProgress(button, "Downloading track…", 0);

      let error = null;

      try {
        await downloadTrack(button);
      } catch (err) {
        error = err;
      }

      // whatever the outcome: the button gets its own look back before
      // any error feedback reads it, and the next click goes through
      clearButtonProgress(button);
      window.SCDL__DOWNLOADING_BUTTON = null;

      if (error) {
        logger.error(error);
        showDownloadErrorFeedback(button, error.message);
      } else {
        hideProgressToast();
      }
    },
    true
  );
};

/**
 * Checks whether the given button group should be
 * appended a child download button.
 * Skip duplicates, and groups that are not directly linked to a track.
 *
 * /!\ This is dirty, but black-listing groups seems better than
 * white-listing because of changes that can be made to the website.
 *
 * @param {HTMLElement} buttonGroup
 * @returns {boolean}
 */
const isValidButtonGroup = (buttonGroup) => {
  if (!buttonGroup) return false;

  const parentButtonNode = buttonGroup.parentNode;

  if (
    !parentButtonNode ||
    !parentButtonNode.classList.contains("soundActions") ||
    window.SCDL__DOM_ELEMENTS.includes(parentButtonNode)
  ) {
    return false;
  }

  // sets, albums, playlists...
  // from a page that is not the set/album/playlist page
  const grandparentElement = parentButtonNode.parentElement?.parentElement;
  const grandparentChildNodes = Array.from(
    grandparentElement?.childNodes
  ).filter((node) => node.className);
  const grandparentContainsTrackList = grandparentChildNodes.some((node) =>
    node.classList?.contains("sound__trackList")
  );

  if (grandparentContainsTrackList) {
    return false;
  }

  // sets, albums, playlists...
  // from the set/album/playlist page
  const pageUrl = new URL(document.URL);
  const isSetPage = pageUrl.pathname.split("/")[2] === "sets";

  if (isSetPage && buttonGroup.classList.contains("sc-button-group-medium")) {
    return false;
  }

  const childButtonNodes = Array.from(buttonGroup.childNodes).filter(
    (node) => node.className
  );

  // related tracks, profile likes...
  const isSideTrack =
    childButtonNodes.length === 2 &&
    childButtonNodes[0]?.classList?.contains("sc-button-like");

  // your latest upload...
  const isPersonalTrack = childButtonNodes.some((node) =>
    node.classList?.contains("sc-button-upload")
  );

  return !isSideTrack && !isPersonalTrack;
};

/**
 * Build the download SVG icon used by the classic-layout download button.
 * @returns {SVGSVGElement}
 */
const createDownloadIconSvg = () => {
  const svgElement = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg"
  );
  svgElement.setAttribute("viewBox", "0 0 16 16");
  svgElement.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svgElement.setAttribute("aria-hidden", "true");

  const pathElement = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path"
  );
  pathElement.setAttribute(
    "d",
    "M8 15A7 7 0 108 1a7 7 0 000 14zm3.47-7.53l1.06 1.06L8 13.06 3.47 8.53l1.06-1.06 2.72 2.72V3h1.5v7.19l2.72-2.72z"
  );
  pathElement.setAttribute("fill", "currentColor");
  pathElement.setAttribute("stroke-width", "1.5");
  pathElement.setAttribute("stroke-linecap", "round");
  pathElement.setAttribute("stroke-linejoin", "round");

  svgElement.appendChild(pathElement);
  return svgElement;
};

/**
 * Insert 'Download' button(s) in the DOM wherever there is a group
 * of buttons that appear to be linked to a track.
 * The size of each button is determined from the size of the buttons of the group.
 */
const insertDownloadButtons = () => {
  const downloadButton = document.createElement("button");

  downloadButton.setAttribute("type", "button");
  downloadButton.setAttribute("tabindex", "0");
  downloadButton.setAttribute("aria-label", "Download");
  downloadButton.setAttribute("role", "button");

  const svgElement = createDownloadIconSvg();

  const divElement = document.createElement("div");
  divElement.appendChild(svgElement);

  const labelElement = document.createElement("span");
  labelElement.classList.add("sc-button-label", "sc-visuallyhidden");
  labelElement.textContent = "Download";

  downloadButton.appendChild(divElement);
  downloadButton.appendChild(labelElement);

  downloadButton.classList.add(
    "sc-button-download",
    "sc-button-secondary",
    "sc-button",
    "sc-button-medium", // default button size
    "sc-button-icon",
    "sc-button-responsive",
    "sc-button-selected" // set icon color to soundcloud orange
  );

  const buttonGroups = document.getElementsByClassName("sc-button-group");
  const validButtonGroups = Array.from(buttonGroups).filter(isValidButtonGroup);

  logger.info(
    `Classic: ${buttonGroups.length} button group(s) found, ${validButtonGroups.length} valid`
  );

  for (const buttonGroup of validButtonGroups) {
    const downloadButtonClone = downloadButton.cloneNode(true);

    if (buttonGroup.classList.contains("sc-button-group-small")) {
      downloadButtonClone.classList.replace(
        "sc-button-medium",
        "sc-button-small"
      );
    }

    attachDownloadClickHandler(downloadButtonClone);

    buttonGroup.appendChild(downloadButtonClone);
    window.SCDL__DOM_ELEMENTS.push(buttonGroup.parentNode);
  }
};

/**
 * Icon path data ("d" attribute) for SoundCloud's own "Download track"
 * button, shown on tracks whose artist enabled downloads. We match on
 * it to spot that button, so we don't add a second, redundant one next
 * to it. We also reuse it to draw our own icon.
 */
const MUI_NATIVE_DOWNLOAD_ICON_PATH =
  "M12.75 3v15.44l5.5-5.5L19.31 14 12 21.31 4.69 14l1.06-1.06 5.5 5.5V3h1.5Z";

/**
 * CSS selector for any MUI dropdown-trigger button on the page: the
 * track's own "More menu", a comment's menu, the comment-sort selector,
 * the sidebar mini-tracks' menus. Anchored on aria-haspopup="true"
 * rather than an aria-label, which is translated per the user's
 * SoundCloud UI language ("More menu" becomes "Plus d'actions" in
 * French). aria-haspopup is a fixed ARIA protocol value and reads the
 * same in every language.
 *
 * watchNewTracksInterval, the only caller, counts them: when that count
 * changes, the page has rendered something new.
 */
const MUI_MENU_TRIGGER_SELECTOR = '[aria-haspopup="true"]';

/**
 * CSS selector for the "More menu" button of a track's own header on
 * the MUI-based track player.
 *
 * The `variant` attribute separates it from every other dropdown in the
 * page: the header's menu button is the only "outlined" one. A
 * comment's menu is "ghost", and the comment-sort selector and the
 * sidebar mini-tracks' menus carry no variant at all. It survives
 * translation, like aria-haspopup, and it isn't a per-build hash, like
 * the MuiStack and MuiBox class names.
 *
 * The header row is only guaranteed to hold that one button: on a track
 * shared through a secret link, SoundCloud renders no Share, Copy link,
 * Repost or add-to-playlist button beside it.
 */
const MUI_TRACK_ACTIONS_SELECTOR = '[aria-haspopup="true"][variant="outlined"]';

/**
 * Checks whether the given "action buttons" container should be
 * appended a download button.
 *
 * Skips containers we've already handled, and containers that hold
 * SoundCloud's own native "Download track" button - some tracks
 * have downloads natively enabled by their artist, and we don't want to
 * add a second, redundant button next to theirs.
 * @param {Element} container
 * @returns {boolean}
 */
const isValidMuiActionsContainer = (container) => {
  if (!container || window.SCDL__DOM_ELEMENTS.includes(container)) return false;

  return !container.querySelector(`path[d="${MUI_NATIVE_DOWNLOAD_ICON_PATH}"]`);
};

/**
 * Find every valid action-buttons container for the MUI-based track
 * player currently in the page. There may be more than one: SoundCloud
 * renders a narrow-viewport and a wide-viewport copy of the same track
 * header simultaneously (toggled via CSS breakpoints), only one of
 * which is visible at a time.
 * @returns {Element[]}
 */
const getMuiActionsContainers = () => {
  const menuButtons = document.querySelectorAll(MUI_TRACK_ACTIONS_SELECTOR);

  return Array.from(menuButtons)
    .map((button) => button.parentElement)
    .filter(isValidMuiActionsContainer);
};

/**
 * Build the download SVG icon used by the MUI-based track player's
 * button. This is SoundCloud's own icon, copied from its native
 * "Download track" button (shown on tracks where the artist has enabled
 * downloads) rather than the classic layout's icon, so ours renders
 * pixel-consistent with its siblings (Share, Repost, etc. all use the
 * same 24x24 viewBox convention).
 * @returns {SVGSVGElement}
 */
const createMuiDownloadIconSvg = () => {
  const svgElement = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg"
  );
  svgElement.setAttribute("viewBox", "0 0 24 24");
  svgElement.setAttribute("width", "24");
  svgElement.setAttribute("height", "24");
  svgElement.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svgElement.setAttribute("aria-hidden", "true");

  const pathElement = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path"
  );
  pathElement.setAttribute("fill", "currentColor");
  pathElement.setAttribute("fill-rule", "evenodd");
  pathElement.setAttribute("d", MUI_NATIVE_DOWNLOAD_ICON_PATH);
  pathElement.setAttribute("clip-rule", "evenodd");

  svgElement.appendChild(pathElement);
  return svgElement;
};

/**
 * Build a 'Download' icon-button by cloning the row's "More menu"
 * button, so it inherits that button's per-build styling without us
 * hardcoding any of it. The menu button is the one the row is found
 * through, so it is always there; the row's other buttons are not.
 *
 * The clone must not read as a menu button to our own selectors. Left
 * as is, it would be counted by the change detection and returned as
 * its container's menu button, and that container would be detected
 * again on the next pass. Removing aria-haspopup prevents that. The id
 * goes too, since ids are unique, along with the ARIA attributes
 * pointing at a menu this button doesn't open.
 *
 * Colors are set via inline style, not an injected stylesheet:
 * SoundCloud's own page script enumerates document.styleSheets and
 * throws a SecurityError reading cssRules off any stylesheet the
 * extension adds.
 * @param {HTMLButtonElement} menuButton
 * @returns {HTMLButtonElement}
 */
const createMuiDownloadButton = (menuButton) => {
  const button = menuButton.cloneNode(true);

  for (const attribute of [
    "id",
    "aria-haspopup",
    "aria-expanded",
    "aria-controls",
  ]) {
    button.removeAttribute(attribute);
  }

  const idleBackground = "rgba(255, 85, 0, 0.6)";
  const hoverBackground = "rgba(255, 85, 0, 0.9)";

  button.setAttribute("aria-label", "Download track");
  button.title = "Download track";
  button.classList.add("scdl-mui-download-button");
  button.style.backgroundColor = idleBackground;
  button.replaceChildren(createMuiDownloadIconSvg());

  button.addEventListener("mouseenter", () => {
    button.style.backgroundColor = hoverBackground;
  });
  button.addEventListener("mouseleave", () => {
    button.style.backgroundColor = idleBackground;
  });

  return button;
};

/**
 * Insert 'Download' button(s) into the MUI-based track player's
 * action-buttons row(s), mirroring insertDownloadButtons() for the
 * classic layout. The two paths share no selectors and no DOM nodes, so
 * neither can disturb the other.
 */
const insertMuiDownloadButtons = () => {
  const trackMenuButtonCount = document.querySelectorAll(
    MUI_TRACK_ACTIONS_SELECTOR
  ).length;
  const containers = getMuiActionsContainers();

  logger.info(
    `MUI: ${trackMenuButtonCount} track menu button(s) found, ${containers.length} valid action row(s)`
  );

  for (const container of containers) {
    const moreMenuButton = container.querySelector(MUI_TRACK_ACTIONS_SELECTOR);
    const downloadButton = createMuiDownloadButton(moreMenuButton);

    attachDownloadClickHandler(downloadButton);

    // insert before "More menu" so it stays last, matching the
    // overflow-menu-trails-everything-else convention of its siblings
    container.insertBefore(downloadButton, moreMenuButton);
    window.SCDL__DOM_ELEMENTS.push(container);
  }
};

/**
 * True if this frame is embedded in a page that isn't itself on
 * soundcloud.com - e.g. a blog post embedding the classic
 * `w.soundcloud.com` widget player.
 *
 * We only need `all_frames: true` (manifest.json) to reach the
 * MUI-based track page's own crossfade iframe. But content_scripts
 * `matches` is checked per-frame against that frame's own URL, and
 * `*://*.soundcloud.com/*` also matches `w.soundcloud.com` - so the same
 * setting that lets us reach the crossfade iframe also injects us into
 * any other soundcloud.com-hosted iframe anywhere, including that
 * classic widget embedded on someone else's page, which we have no
 * reason to touch.
 * @returns {boolean}
 */
const isThirdPartyEmbed = () => {
  if (window.top === window) return false;

  try {
    return !/(^|\.)soundcloud\.com$/.test(window.top.location.hostname);
  } catch (err) {
    return true; // cross-origin top === definitely not a soundcloud.com page
  }
};

/**
 * Scan a document's <script> tags for a SoundCloud asset bundle
 * (sndcdn.com/assets/<id>), fetching each candidate until one's
 * contents reveal the session's clientId.
 * @param {Document} doc
 * @returns {Promise<string|undefined>}
 */
const findClientIdInDocument = async (doc) => {
  const scriptElements = doc.getElementsByTagName("script");
  const scriptSources = Array.from(scriptElements).reduce((acc, elem) => {
    const src = elem.getAttribute("src") || "";
    return src.match(/sndcdn.com\/assets\/[0-9][0-9]*/g) ? [...acc, src] : acc;
  }, []);

  // iterate through all the scripts and
  // fetch each one until finding the clientId
  const regex = /,client_id:"([a-zA-Z0-9]{32})"/;
  for (const src of scriptSources) {
    try {
      const res = await fetch(src);
      if (!res.ok) continue;

      const data = await res.text();
      const match = data.match(regex);
      const clientId = match?.[1];

      if (clientId) return clientId;
    } catch (err) {
      continue; // ignore fetch errors and keep trying
    }
  }

  return undefined;
};

/**
 * Try to find the SoundCloud clientId for the current user session, and
 * set it to `window.SCDL__CLIENT_ID`.
 *
 * On the MUI-based track player, which renders inside a same-origin
 * iframe, this frame's own document never references a sndcdn.com/assets
 * bundle (the new app's scripts are served from a different host
 * entirely). So a sub-frame goes straight to fetching and scanning the
 * top-level page's document instead, which is still the classic app shell
 * and does reference one; the top frame scans its own document, same as
 * always.
 *
 * Does nothing on a third-party embed. isThirdPartyEmbed() is checked
 * here as well as in the interval, since this function runs
 * unconditionally at startup. Having nothing to do there is not a
 * failure, so it logs and returns instead of throwing.
 */
const setClientId = async () => {
  if (isThirdPartyEmbed()) {
    logger.info("Third-party embed, not soundcloud.com - nothing to do here");
    return;
  }

  let clientId;

  if (window.top === window) {
    clientId = await findClientIdInDocument(document);
  } else {
    try {
      const topRes = await fetch(window.top.location.href);
      const topHtml = await topRes.text();
      const topDocument = new DOMParser().parseFromString(topHtml, "text/html");

      clientId = await findClientIdInDocument(topDocument);
    } catch (err) {
      // network or parse failure - fall through
    }
  }

  if (!clientId) {
    throw new Error("Failed to find SoundCloud clientId...");
  }

  window.SCDL__CLIENT_ID = clientId;

  logger.info(`Found SoundCloud clientId: ${clientId}`);
};

(async () => {
  try {
    await setClientId();
  } catch (err) {
    logger.error(err);
  }
})();
