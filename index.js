window.SCDL__CLIENT_ID = null;
window.SCDL__LAST_URL = null;
window.SCDL__TRACK_COUNT = 0;
window.SCDL__DOM_ELEMENTS = [];

/**
 * Check every second for new loaded tracks
 * in the page to add download button to
 */
const watchNewTracksInterval = setInterval(() => {
  try {
    const currentUrl = document.URL;
    const nbShareButtons = document.querySelectorAll(".sc-button-share").length;

    if (
      window.SCDL__CLIENT_ID
          && (currentUrl !== window.SCDL__LAST_URL
          || nbShareButtons !== window.SCDL__TRACK_COUNT)
    ) {
      insertDownloadButtons();
      window.SCDL__TRACK_COUNT = nbShareButtons;
      window.SCDL__LAST_URL = currentUrl;
    }
  } catch (err) {
    console.error(err);
  }
}, 1000);

/**
 * Stop the interval when the user navigates away from the page
 */
window.addEventListener("beforeunload", () => {
  clearInterval(watchNewTracksInterval);
});

/**
 * Write metadatas to track buffer and save it as mp3 file.
 * @param {object} metadata 
 * @param {ArrayBuffer} trackBuffer 
 * @param {ArrayBuffer} artworkBuffer 
 */
const tagAndSaveTrack = (metadata, trackBuffer, artworkBuffer) => {
  const writer = new ID3Writer(trackBuffer);

  writer
    .setFrame("TPE1", [metadata.user?.username])
		.setFrame("TIT2", metadata.title)
		.setFrame("TYER", metadata.created_at?.split("-")[0]) // keep only year from date
		.setFrame("TCON", [metadata.genre])
		.setFrame("WOAS", metadata.permalink_url)
		.setFrame("APIC", {
			type: 3,
			data: artworkBuffer,
			description: "Track artwork"
	  });

  writer.addTag();
  
  saveAs(
    writer.getBlob(),
    `${metadata.user?.username} - ${metadata.title}.mp3`.toLowerCase()
  );

	writer.revokeURL(); // memory control
};

/**
 * Find a working transcoding for the track and return it.
 * @param {object[]} transcodings 
 * @returns {Promise<any>}
 */
const getStreamData = async (transcodings) => {
  // prioritizes 'progressive' transcoding format
  transcodings.sort((a, b) => {
    if (a.format.protocol === "progressive") return -1;
    if (b.format.protocol === "progressive") return 1;
    return 0;
  });

  for (const transcoding of transcodings) {
    console.info(`Trying with '${transcoding.format?.protocol}' transcoding ('${transcoding.format?.mime_type}' MIME type)...`);

    const streamUrl = new URL(transcoding.url);
    
    streamUrl.searchParams.set("client_id", window.SCDL__CLIENT_ID);

    const streamRes = await fetch(streamUrl.toString());

    if (streamRes.status === 200) return streamRes.json();
  }

  throw new Error(`Couldn't get stream data from transcoding URL...`);
}

/**
 * Resolve track metadata and buffers for download.
 * @param {string} url 
 * @returns {object}
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
  const streamData = await getStreamData(resolveData?.media?.transcodings);
  
  const trackUrl = new URL(streamData.url);
  trackUrl.searchParams.set("client_id", window.SCDL__CLIENT_ID);

  const artworkUrl = (resolveData?.artwork_url || resolveData?.user?.avatar_url)
    .replace(/large/ig, "t500x500");

  const [
    trackRes,
    artworkRes
  ] = await Promise.all([
    fetch(trackUrl.toString()),
    fetch(artworkUrl)
  ]);

  if (trackRes.status !== 200 || artworkRes.status !== 200) {
    throw new Error(`Error while fetching track/artwork data...`);
  }

  const [
    trackBuffer,
    artworkBuffer
  ] = await Promise.all([
    trackRes.arrayBuffer(),
    artworkRes.arrayBuffer()
  ]);

  return { resolveData, trackBuffer, artworkBuffer };
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
    throw new Error("Couldn't find track URL...");
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
  const { resolveData, trackBuffer, artworkBuffer } = await resolveTrack(trackURL);

  tagAndSaveTrack(resolveData, trackBuffer, artworkBuffer);
};

/**
 * Checks whether the given button group should be
 * appended a child download button.
 * Skip duplicates, and groups that are not directly linked to a track.
 * @param {HTMLElement} buttonGroup 
 * @returns {boolean}
 */
const isValidButtonGroup = (buttonGroup) => {
  if (!buttonGroup) return false;

  const childButtonNodes = Array.from(buttonGroup.childNodes)
    .filter((node) => node.className);

  const [
    isSet,
    isSideTrack,
    isUserProfile
  ] = [
    childButtonNodes[4]?.classList?.contains("addToNextUp"),
    childButtonNodes.length === 2
      && childButtonNodes[0]?.classList?.contains("sc-button-like"),
    childButtonNodes.some((node) =>
      node.classList?.contains("sc-button-startstation"))
  ];
  
  return !isSet && !isSideTrack && !isUserProfile
    && !window.SCDL__DOM_ELEMENTS.includes(buttonGroup.parentNode);
}

/**
 * Insert 'Download' button(s) in the DOM wherever there is a group
 * of buttons that appear to be linked to a track.
 * The size of each button is determined from the size of the buttons of the group.
 */
const insertDownloadButtons = () => {
  // create html anchor element
  const downloadButton = document.createElement("a");
  const downloadButtonText = document.createTextNode("Download");

  downloadButton.appendChild(downloadButtonText);
  downloadButton.setAttribute("title", "Download");
  downloadButton.classList.add(
    // "sc-button-disabled",
    // "sc-button-icon",
    "sc-button-download",
    "sc-button",
    "sc-button-medium", // default button size
    "sc-button-responsive"
  );

  // get all button groups in the page
  const buttonGroups = document.getElementsByClassName("sc-button-group");

  for (const buttonGroup of buttonGroups) {
    if (!isValidButtonGroup(buttonGroup)) continue;

    const downloadButtonClone = downloadButton.cloneNode(true);

    if (buttonGroup.classList.contains("sc-button-group-small")) {
      // change button size if needed
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
  for (const src of scriptSources) {
    const res = await fetch(src);
    const data = await res.text();

    const match = data.match(new RegExp(",client_id:\"(.*)\",env:\"production\""));
    const clientId = match?.find((str) => str.length === 32);

    if (clientId) {
      window.SCDL__CLIENT_ID = clientId;

      return;
    }
  }

  throw new Error("Couldn't find SoundCloud clientId...");
};

(async () => {
  try {
    await setClientId();

    console.info(`Found SoundCloud clientId! ${window.SCDL__CLIENT_ID}`);

    insertDownloadButtons();
  } catch (err) {
    console.error(err);
  }
})();
