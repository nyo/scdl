"use strict";

window.SCDL__CLIENT_ID = null;
window.SCDL__LAST_URL = null;
window.SCDL__NB_CLASSIC_BUTTON_GROUPS = 0;
window.SCDL__NB_MUI_MENU_BUTTONS = 0;
window.SCDL__DOM_ELEMENTS = [];
window.SCDL__ERROR_TOAST_ELEMENT = null;
window.SCDL__ERROR_TOAST_TIMEOUT = null;

/**
 * Human-readable label for which frame this code is currently running
 * in - "top frame" or "iframe" - since watchNewTracksInterval and
 * setClientId both run once per frame (every frame the content script
 * gets injected into runs its own independent copy of this whole
 * script), so every log benefits from knowing which one it's from.
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

  writer.revokeURL(); // memory control
};

/**
 * Converts blob to arrayBuffer (for `resolveHlsBuffer`).
 * @param {Blob} blob
 * @returns {Promise<ArrayBuffer>}
 */
const blobToArrayBuffer = (blob) => {
  return new Promise((resolve) => {
    const reader = new FileReader();

    reader.readAsArrayBuffer(blob);
    reader.onload = () => {
      resolve(reader.result);
    };
  });
};

/**
 * Resolve track with 'hls' transcoding format.
 * @param {string} trackUrl
 * @param {ArrayBuffer} artworkBuffer
 * @param {object} metadata
 */
const resolveHlsBuffer = (trackUrl, artworkBuffer, metadata) => {
  return new Promise((resolve, reject) => {
    const audioElement = new Audio();
    const mediaSource = new MediaSource();

    const handleMediaSourceOpen = async (event) => {
      event.preventDefault();

      try {
        const trackRes = await fetch(trackUrl);

        if (trackRes.status !== 200) {
          throw new Error("Error while fetching 'hls' track URL...");
        }

        const trackData = await trackRes.text();

        const mp3Urls = trackData
          .split("\n")
          .filter((line) => line && !line.startsWith("#"))
          .map((line) => new URL(line, trackUrl).toString());

        const arrayBuffers = await Promise.all(
          mp3Urls.map((url) => fetch(url).then((res) => res.arrayBuffer()))
        );
        const blob = new Blob(arrayBuffers);
        const trackArrayBuffer = await blobToArrayBuffer(blob);

        await tagAndSaveTrack(trackArrayBuffer, artworkBuffer, metadata);

        resolve();
      } catch (err) {
        reject(err);
      }
    };

    audioElement.src = URL.createObjectURL(mediaSource);
    mediaSource.addEventListener("sourceopen", handleMediaSourceOpen);
  });
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
 * User-facing message for both DRM failure paths in fetchStreamData - no
 * candidate transcoding was ever advertised, or candidates existed but
 * every endpoint 404'd. That distinction is a diagnostic detail, not
 * something the end-user needs to know; the outcome is the same either way.
 */
const DRM_ERROR_MESSAGE =
  "This track is now copy-protected by SoundCloud (like a Netflix show or Spotify song) and can't be downloaded :(";

/**
 * Find a working transcoding for the track and return its data.
 * @param {object[]} transcodings
 * @returns {Promise<any>}
 */
const fetchStreamData = async (transcodings) => {
  // keep only 'audio/mpeg' mime types
  // & prioritizes 'progressive' transcoding format
  const filteredTranscodings = transcodings.reduce((acc, t) => {
    if (t.format.mime_type === "audio/mpeg") {
      if (t.format.protocol === "progressive") {
        acc.unshift(t);
      } else {
        acc.push(t);
      }
    }

    return acc;
  }, []);

  // soundcloud advertises encrypted-only transcodings for DRM-protected tracks;
  // no mp3 stream is ever offered for those.
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

  // legacy mp3 transcodings advertised but every endpoint 404'd:
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

  return resolveRes.json();
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
    return window.top !== window ? window.top.location.href : document.URL;
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
 * Shared "error" red, used for both the toast background and the download
 * button's error background so they read as the same state.
 */
const ERROR_BACKGROUND_COLOR = "#ff0000";

/**
 * Get the single shared error toast element, creating and appending it to
 * the page on first use. Reused across errors instead of creating a new
 * element each time, so a second error while one's still showing just
 * replaces its message rather than stacking a duplicate on screen.
 * @returns {HTMLElement}
 */
const getErrorToastElement = () => {
  if (window.SCDL__ERROR_TOAST_ELEMENT) {
    return window.SCDL__ERROR_TOAST_ELEMENT;
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
  toast.style.backgroundColor = ERROR_BACKGROUND_COLOR;
  toast.style.color = "#fff";
  toast.style.fontSize = "14px";
  toast.style.fontFamily = "sans-serif";
  toast.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.4)";

  document.body.appendChild(toast);
  window.SCDL__ERROR_TOAST_ELEMENT = toast;

  return toast;
};

/**
 * Show the given message in the shared error toast for 5 seconds. Restarts
 * the timer on repeat calls instead of stacking timeouts, so a second error
 * while one's still showing just replaces the message and keeps it visible
 * for a fresh 5 seconds.
 * @param {string} message
 */
const showErrorToast = (message) => {
  const toast = getErrorToastElement();

  toast.textContent = message;
  toast.style.display = "block";

  clearTimeout(window.SCDL__ERROR_TOAST_TIMEOUT);
  window.SCDL__ERROR_TOAST_TIMEOUT = setTimeout(() => {
    toast.style.display = "none";
  }, 5000);
};

/**
 * Briefly turn the download button red and surface the error message via
 * its title attribute and a screen-corner toast (so it's visible without
 * hovering). Clears any pending reset so rapid clicks don't cause the
 * button to revert to its normal state mid-error.
 *
 * Restores whatever backgroundColor/color/title the button had before
 * the error (captured once, not on repeat clicks while already red) -
 * not hardcoded empty strings, since the MUI button has its own idle
 * inline background color and title that aren't "".
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
  button.style.backgroundColor = ERROR_BACKGROUND_COLOR;
  button.style.color = "#fff";

  button._scdlResetTimeout = setTimeout(() => {
    button.style.backgroundColor = button._scdlIdleState.backgroundColor;
    button.style.color = button._scdlIdleState.color;
    button.title = button._scdlIdleState.title;
    button._scdlResetTimeout = null;
  }, 5000);
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

  const streamDataUrl = new URL(streamData.url);

  streamDataUrl.searchParams.set("client_id", window.SCDL__CLIENT_ID);

  const trackUrl = streamDataUrl.toString();

  if (streamData.protocol === "progressive") {
    await resolveProgressiveBuffer(trackUrl, artworkBuffer, resolveData);
  } else if (streamData.protocol === "hls") {
    await resolveHlsBuffer(trackUrl, artworkBuffer, resolveData);
  } else {
    throw new Error("Failed to resolve track: Unknown protocol.");
  }
};

/**
 * Wire up a download button's click handler: run downloadTrack, and on
 * failure log the error and flash the button red via showDownloadErrorFeedback.
 * Shared by both the classic and MUI insertion paths.
 * @param {HTMLElement} button
 */
const attachDownloadClickHandler = (button) => {
  button.addEventListener(
    "click",
    async () => {
      try {
        await downloadTrack(button);
      } catch (err) {
        logger.error(err);
        showDownloadErrorFeedback(button, err.message);
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
  // create the new download button to be inserted
  const downloadButton = document.createElement("button");

  // set button attributes
  downloadButton.setAttribute("type", "button");
  downloadButton.setAttribute("tabindex", "0");
  downloadButton.setAttribute("aria-label", "Download");
  downloadButton.setAttribute("role", "button");

  // create SVG icon
  const svgElement = createDownloadIconSvg();

  // create div to contain SVG
  const divElement = document.createElement("div");
  divElement.appendChild(svgElement);

  // create visually hidden label
  const labelElement = document.createElement("span");
  labelElement.classList.add("sc-button-label", "sc-visuallyhidden");
  labelElement.textContent = "Download";

  // add elements to button
  downloadButton.appendChild(divElement);
  downloadButton.appendChild(labelElement);

  // add classes
  downloadButton.classList.add(
    "sc-button-download",
    "sc-button-secondary",
    "sc-button",
    "sc-button-medium", // default button size
    "sc-button-icon",
    "sc-button-responsive",
    "sc-button-selected" // set icon color to soundcloud orange
  );

  // get all button groups in the page
  const buttonGroups = document.getElementsByClassName("sc-button-group");
  const validButtonGroups = Array.from(buttonGroups).filter(isValidButtonGroup);

  logger.info(
    `Classic: ${buttonGroups.length} button group(s) found, ${validButtonGroups.length} valid`
  );

  for (const buttonGroup of validButtonGroups) {
    const downloadButtonClone = downloadButton.cloneNode(true);

    // change button size if needed
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
 * Icon path data ("d" attribute) for the MUI-based track player's action
 * buttons. Their aria-labels are translated per the user's SoundCloud UI
 * language (e.g. "Share" becomes "Partager" in French), which breaks any
 * detection based on that text - but the icon artwork itself is the same
 * regardless of language, so matching on it is locale-independent. Only
 * one path per icon is used even where an icon is drawn from several
 * (Copy link, Repost) - enough to identify it, no need to match all of
 * them.
 */
const MUI_SHARE_ICON_PATH =
  "M20.25 12.75V20.25H3.75V12.75M12 15V4.5M16.5 8.25L12 3.75L7.5 8.25";
const MUI_COPY_LINK_ICON_PATH =
  "M18.8058 5.0691C16.9508 3.21411 13.9433 3.21411 12.0883 5.0691L10.1843 6.97311C10.8172 6.93366 11.4563 7.01402 12.0645 7.21421L13.1489 6.12976C14.4181 4.86056 16.4759 4.86056 17.7451 6.12976C19.0143 7.39896 19.0143 9.45675 17.7451 10.726L15.6238 12.8473C14.3546 14.1165 12.2968 14.1165 11.0276 12.8473C10.717 12.5367 10.4824 12.1788 10.3238 11.7968C9.82388 11.8256 9.32979 11.9789 8.89196 12.2567C9.0373 12.6347 9.23273 12.9979 9.47825 13.336L9.96695 13.9079C11.8219 15.7629 14.8295 15.7629 16.6845 13.9079L18.8058 11.7866C20.6608 9.93162 20.6608 6.92409 18.8058 5.0691Z";
const MUI_REPOST_ICON_PATH =
  "M19 4.25C19.4142 4.25 19.75 4.58579 19.75 5V17.1992L22.0039 14.9395L23.0654 15.998L19.5361 19.54C19.3954 19.6811 19.2041 19.7607 19.0049 19.7607C18.8057 19.7607 18.6143 19.6811 18.4736 19.54L14.9443 15.998L16.0068 14.9395L18.25 17.1895V5.75H11.25V4.25H19Z";
const MUI_ADD_TO_PLAYLIST_ICON_PATH =
  "M12 3.75V12M12 12V20.25M12 12H3.75M12 12H20.25";
const MUI_NATIVE_DOWNLOAD_ICON_PATH =
  "M12.75 3v15.44l5.5-5.5L19.31 14 12 21.31 4.69 14l1.06-1.06 5.5 5.5V3h1.5Z";

/**
 * CSS selector for a MUI dropdown-trigger button - the "More menu"
 * button, among others. Anchored on aria-haspopup="true" rather than the
 * "More menu" aria-label for the same reason as the icon paths above:
 * it's a fixed ARIA protocol value, never translated, unlike aria-label
 * text (e.g. "More menu" becomes "Plus d'options" in French). This also
 * matches unrelated dropdowns elsewhere on the page (a comment-sort
 * selector, sidebar mini-tracks' own menus) - isValidMuiActionsContainer's
 * icon-path checks filter those back out.
 */
const MUI_MENU_TRIGGER_SELECTOR = '[aria-haspopup="true"]';

/**
 * Checks whether the given element is a valid "action buttons" container
 * for the MUI-based track player - the row containing
 * Share / Copy link / Repost / add to playlist / More menu for a track's
 * own header. Comment rows and sidebar mini-tracks have their own "More
 * menu" (or "More actions for this track") button too, but never all
 * five siblings together, so requiring all five is specific enough
 * without needing the classic code's blacklist heuristics.
 *
 * Also skips containers that already have SoundCloud's own native
 * "Download track" button - some tracks have downloads natively enabled
 * by their artist, and we don't want to add a second, redundant button
 * next to theirs.
 * @param {Element} container
 * @returns {boolean}
 */
const isValidMuiActionsContainer = (container) => {
  if (!container || window.SCDL__DOM_ELEMENTS.includes(container)) return false;
  if (container.querySelector(`path[d="${MUI_NATIVE_DOWNLOAD_ICON_PATH}"]`)) return false;

  const requiredIconPaths = [
    MUI_SHARE_ICON_PATH,
    MUI_COPY_LINK_ICON_PATH,
    MUI_REPOST_ICON_PATH,
    MUI_ADD_TO_PLAYLIST_ICON_PATH,
  ];

  return requiredIconPaths.every((path) => container.querySelector(`path[d="${path}"]`));
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
  const menuButtons = document.querySelectorAll(MUI_MENU_TRIGGER_SELECTOR);

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
 * Build a 'Download' icon-button by cloning the "Copy link" button
 * (always present per isValidMuiActionsContainer) so it inherits that
 * button's actual per-build styling without us hardcoding any of it.
 *
 * Colors are set via inline style, not an injected stylesheet:
 * SoundCloud's own page script enumerates document.styleSheets and
 * throws a SecurityError reading cssRules off any stylesheet the
 * extension adds.
 * @param {Element} container
 * @returns {HTMLButtonElement}
 */
const createMuiDownloadButton = (container) => {
  const copyLinkIcon = container.querySelector(`path[d="${MUI_COPY_LINK_ICON_PATH}"]`);
  const button = copyLinkIcon.closest("button").cloneNode(true);

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
 * classic layout. Runs independently of, and never touches, the
 * classic-layout insertion above - the two paths share no selectors,
 * classnames, or DOM nodes.
 */
const insertMuiDownloadButtons = () => {
  const menuButtonCount = document.querySelectorAll(MUI_MENU_TRIGGER_SELECTOR).length;
  const containers = getMuiActionsContainers();

  logger.info(
    `MUI: ${menuButtonCount} dropdown-trigger button(s) found, ${containers.length} valid action row(s)`
  );

  for (const container of containers) {
    const downloadButton = createMuiDownloadButton(container);
    const moreMenuButton = container.querySelector(MUI_MENU_TRIGGER_SELECTOR);

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
 * reason to touch. This guards against that side effect.
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
 * Does nothing on a third-party embed (isThirdPartyEmbed() checked here
 * too, not just relied on via the interval, since this function runs
 * unconditionally at startup) - not an error, just nothing to do.
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
