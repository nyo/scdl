#!/bin/bash

version=$(cat manifest.json | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')
build_name="scdl-$version.zip"

if ! zip -r "$build_name" icons/ libs/ index.js manifest.json; then
    echo "Error: Failed to create archive: $build_name"
    exit 1
fi

echo "Archive created: $build_name"