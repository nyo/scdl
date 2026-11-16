"use strict";

/**
 * Message type the content script uses to hand a finished track to the
 * downloads API, which content scripts can't call directly.
 */
const DOWNLOAD_MESSAGE_TYPE = "scdl-download-track";

/** Blob URLs kept until Firefox finishes with the download. */
const blobUrlsByDownloadId = new Map();

/**
 * Starts a download from an in-memory track blob. Download errors are
 * returned to the content script rather than thrown, so it can tell
 * "Firefox refused this file" apart from "the background page is
 * unreachable" and only fall back to FileSaver for the latter.
 * @param {{blob: Blob, filename: string}} message
 * @returns {Promise<{id?: number, error?: string}>}
 */
const startDownload = async ({ blob, filename }) => {
  if (!(blob instanceof Blob)) {
    return { error: "The track data is not a file." };
  }

  const url = URL.createObjectURL(blob);

  try {
    const id = await browser.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
    });

    blobUrlsByDownloadId.set(id, url);

    return { id };
  } catch (err) {
    URL.revokeObjectURL(url);
    return { error: err?.message || String(err) };
  }
};

browser.runtime.onMessage.addListener((message) => {
  if (message?.type !== DOWNLOAD_MESSAGE_TYPE) return undefined;

  return startDownload(message);
});

browser.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;

  if (state !== "complete" && state !== "interrupted") return;

  const url = blobUrlsByDownloadId.get(delta.id);

  if (url) {
    URL.revokeObjectURL(url);
    blobUrlsByDownloadId.delete(delta.id);
  }
});
