"use strict";

const EXAMPLE_DATA = {
  artist: "Daft Punk",
  title: "Around The World",
  year: "1997",
  genre: "Electronic",
  album: "Homework",
  username: "daftpunkofficial",
  comment: "Classic track",
};

const formatInput = document.getElementById("format");
const lowercaseCheckbox = document.getElementById("lowercase");
const previewText = document.getElementById("preview-text");
const saveButton = document.getElementById("save");
const saveStatus = document.getElementById("save-status");

const showStatus = (message, isSuccess = true, duration = null) => {
  saveStatus.textContent = message;
  saveStatus.className = `setting-section-save-status ${
    isSuccess ? "success" : "error"
  }`;

  if (duration) {
    setTimeout(() => {
      saveStatus.textContent = "";
      saveStatus.className = "setting-section-save-status";
    }, duration);
  }
};

const updatePreview = () => {
  const format = formatInput.value || SCDL__FORMAT_DEFAULTS.format;
  let filename = applyFormat(format, EXAMPLE_DATA);

  if (lowercaseCheckbox.checked) {
    filename = filename.toLowerCase();
  }

  previewText.textContent = filename + ".mp3";
};

const saveSettings = () => {
  const settings = {
    format: formatInput.value || SCDL__FORMAT_DEFAULTS.format,
    lowercase: lowercaseCheckbox.checked,
  };

  browser.storage.sync
    .set(settings)
    .then(() => showStatus("Saved!", true, 2000))
    .catch((error) => {
      const errorMsg = error?.message || String(error);
      showStatus(`Error: ${errorMsg}`, false);
    });
};

const loadSettings = () => {
  browser.storage.sync
    .get(SCDL__FORMAT_DEFAULTS)
    .then((settings) => {
      formatInput.value = settings.format;
      lowercaseCheckbox.checked = settings.lowercase;
      updatePreview();
    })
    .catch((error) => {
      // Fallback to defaults and show error
      formatInput.value = SCDL__FORMAT_DEFAULTS.format;
      lowercaseCheckbox.checked = SCDL__FORMAT_DEFAULTS.lowercase;
      updatePreview();

      const errorMsg = error?.message || String(error);
      showStatus(`Error loading settings: ${errorMsg}`, false);
    });
};

formatInput.addEventListener("input", updatePreview);
lowercaseCheckbox.addEventListener("change", updatePreview);
saveButton.addEventListener("click", saveSettings);

updatePreview();
loadSettings();
