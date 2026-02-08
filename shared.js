"use strict";

const SCDL__FORMAT_DEFAULTS = {
  format: "{artist} - {title}",
  lowercase: false,
};

const applyFormat = (format, data) => {
  return format.replace(/\{(\w+)\}/g, (_, token) => {
    return data[token] !== undefined && data[token] !== null ? data[token] : "";
  });
};
