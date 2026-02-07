"use strict";

window.SCDL__CLIENT_ID = null;
window.SCDL__LAST_URL = null;
window.SCDL__NB_PAGE_BUTTON_GROUP = 0;
window.SCDL__DOM_ELEMENTS = [];

/**
 * Define custom logger object for logging
 * with a prefixed tag to differenciate add-on logs.
 */
const SCDL_LOG_PREFIX = "[scdl]";
const logger = {
  info: console.info.bind(console, SCDL_LOG_PREFIX),
  error: console.error.bind(console, SCDL_LOG_PREFIX)
}

const SCDL__FORMAT_DEFAULTS = {
  format: "{artist} - {title}",
  lowercase: true
};

const applyFormat = (format, data) => {
  return format.replace(/\{(\w+)\}/g, (_, token) => {
    return data[token] !== undefined && data[token] !== null
      ? data[token]
      : "";
  });
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
    const pageUrl = document.URL;
    const pageButtonGroups = document.getElementsByClassName("sc-button-group");
    const nbPageButtonGroups = pageButtonGroups?.length;

    if (
      window.SCDL__CLIENT_ID
        && (pageUrl !== window.SCDL__LAST_URL
        || nbPageButtonGroups !== window.SCDL__NB_PAGE_BUTTON_GROUP)
    ) {
      insertDownloadButtons();
      window.SCDL__LAST_URL = pageUrl;
      window.SCDL__NB_PAGE_BUTTON_GROUP = nbPageButtonGroups;
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

  const songArtist = metadata.publisher_metadata?.artist
    || metadata.user?.username;

  if (songArtist) {
    writer.setFrame("TPE1", [songArtist]);
  }

  const songTitle = metadata.publisher_metadata?.release_title
    || metadata.title;

  if (songTitle) {
    writer.setFrame("TIT2", songTitle);
  }

  // keep only year from date
  const albumReleaseYear = metadata.release_date
    || metadata.created_at?.split("-")?.[0];

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
      description: "Track artwork"
	  });
  }

  const songDescription = metadata.description;

  if (songDescription) {
    writer.setFrame("COMM", {
      description: "",
      text: songDescription
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
    comment: songDescription || ""
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
    reader.onload = () => { resolve(reader.result); };
  });
};

/**
 * Resolve track with 'hls' transcoding format.
 * @param {string} trackUrl
 * @param {ArrayBuffer} artworkBuffer
 * @param {object} metadata
 */
const resolveHlsBuffer = (trackUrl, artworkBuffer, metadata) => {
  const audioElement = new Audio();
  const mediaSource = new MediaSource();

  const handleMediaSourceOpen = async (event) => {
    event.preventDefault();

    const trackRes = await fetch(trackUrl);

    if (trackRes.status !== 200) {
      throw new Error("Error while fetching 'hls' track URL...");
    }

    const trackData = await trackRes.text();

    const mp3Urls = trackData
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => new URL(line, trackUrl).toString());

    Promise.all(
      mp3Urls.map(
        (url) => fetch(url).then((res) => res.arrayBuffer())
      )
    )
      .then(async (arrayBuffers) => {
        const blob = new Blob(arrayBuffers);
        const trackArrayBuffer = await blobToArrayBuffer(blob);

        await tagAndSaveTrack(trackArrayBuffer, artworkBuffer, metadata);
      });
  };

  audioElement.src = URL.createObjectURL(mediaSource);
  mediaSource.addEventListener("sourceopen", handleMediaSourceOpen);
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

  const artworkRes = await fetch(artworkUrl.replace(/large/ig, "t500x500"));

  if (artworkRes.status !== 200) {
    throw new Error("Error while fetching artwork URL...");
  }

  return artworkRes.arrayBuffer();
};

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
  }

  throw new Error("Failed to get stream data from transcoding URL...");
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
    "playableTile__mainHeading"
  ];

  if (!validClassNames.some((className) => link.className?.includes(className))) {
    return false;
  }

  const ignoredPaths = [
    "/stream",
    "/comments"
  ];

  return !ignoredPaths.some((path) => link.href.includes(path));
};

/**
 * Get URL of the track linked to the download button.
 * @param {HTMLAnchorElement} buttonElement
 * @returns {string}
 */
const getTrackURL = (buttonElement) => {
  const node = [
    ".streamContext",
    ".chartTrack",
    ".trackItem"
  ]
    .map((selector) => buttonElement.closest(selector))
    .find(Boolean);

  if (!node) return document.URL;

  const links = node.querySelectorAll("a");
  const longestValidLink = Array.from(links).reduce(
    (acc, link) => isValidLink(link) && link.href.length > acc.href.length
      ? link
      : acc,
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
 * Get track URL, resolve its metadata, tag and save as .mp3 file.
 * @param {HTMLElement} buttonElement
 */
const downloadTrack = async (buttonElement) => {
  const trackURL = getTrackURL(buttonElement);
  const resolveData = await resolveTrack(trackURL);
  const streamData = await fetchStreamData(resolveData?.media?.transcodings);

  let artworkBuffer;
  try {
    artworkBuffer = await resolveArtworkBuffer(resolveData?.artwork_url || resolveData?.user?.avatar_url);
  } catch (err) {
    logger.error(err);
  }

  const streamDataUrl = new URL(streamData.url);

  streamDataUrl.searchParams.set("client_id", window.SCDL__CLIENT_ID);

  const trackUrl = streamDataUrl.toString();

  if (streamData.protocol === "progressive") {
    resolveProgressiveBuffer(trackUrl, artworkBuffer, resolveData);
  } else if (streamData.protocol === "hls") {
    resolveHlsBuffer(trackUrl, artworkBuffer, resolveData);
  } else {
    throw new Error("Failed to resolve track: Unknown protocol.");
  }
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
  const grandparentChildNodes = Array.from(grandparentElement?.childNodes)
    .filter((node) => node.className);
  const grandparentContainsTrackList = grandparentChildNodes
    .some((node) => node.classList?.contains("sound__trackList"))

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

  const childButtonNodes = Array.from(buttonGroup.childNodes)
    .filter((node) => node.className);

  // related tracks, profile likes...
  const isSideTrack = childButtonNodes.length === 2
    && childButtonNodes[0]?.classList?.contains("sc-button-like")

  // your latest upload...
  const isPersonalTrack = childButtonNodes.some((node) =>
    node.classList?.contains("sc-button-upload"));

  return !isSideTrack && !isPersonalTrack;
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
  const svgElement = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgElement.setAttribute("viewBox", "0 0 16 16");
  svgElement.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svgElement.setAttribute("aria-hidden", "true");
  
  // create download icon path
  const pathElement = document.createElementNS("http://www.w3.org/2000/svg", "path");
  pathElement.setAttribute("d", "M8 15A7 7 0 108 1a7 7 0 000 14zm3.47-7.53l1.06 1.06L8 13.06 3.47 8.53l1.06-1.06 2.72 2.72V3h1.5v7.19l2.72-2.72z");
  pathElement.setAttribute("fill", "currentColor");
  pathElement.setAttribute("stroke-width", "1.5");
  pathElement.setAttribute("stroke-linecap", "round");
  pathElement.setAttribute("stroke-linejoin", "round");
  
  svgElement.appendChild(pathElement);
  
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

  for (const buttonGroup of buttonGroups) {
    if (!isValidButtonGroup(buttonGroup)) continue;

    const downloadButtonClone = downloadButton.cloneNode(true);

    // change button size if needed
    if (buttonGroup.classList.contains("sc-button-group-small")) {
      downloadButtonClone.classList.replace(
        "sc-button-medium",
        "sc-button-small"
      );
    }

    downloadButtonClone.addEventListener(
      "click",
      () => { downloadTrack(downloadButtonClone); },
      true
    );

    buttonGroup.appendChild(downloadButtonClone);
    window.SCDL__DOM_ELEMENTS.push(buttonGroup.parentNode);
  }
};

/**
 * Try to find the SoundCloud clientId for the current
 * user session, and set it to `window.SCDL__CLIENT_ID`.
 */
const setClientId = async () => {
  const scriptElements = document.getElementsByTagName("script");
  const scriptSources = Array.from(scriptElements).reduce(
    (acc, elem) =>
      elem.src.match(/sndcdn.com\/assets\/[0-9][0-9]*/g)
        ? [...acc, elem.src]
        : acc,
    []
  );

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
  
      if (clientId) {
        window.SCDL__CLIENT_ID = clientId;
        return;
      }
    } catch (err) {
      continue; // ignore fetch errors and keep trying
    }
  }

  throw new Error("Failed to find SoundCloud clientId...");
};

(async () => {
  try {
    await setClientId();

    logger.info(`Found SoundCloud clientId: ${window.SCDL__CLIENT_ID}`);
  } catch (err) {
    logger.error(err);
  }
})();
