# Frame Plucker

After Effects panel that removes held frames from video without modifying the
original file.

## Install

1. File > Scripts > Install ScriptUI Panel > `frame-plucker.jsx`.
2. Enable **Allow Scripts to Write Files and Access Network** in After Effects
   settings.
3. Window > Frame Plucker.

## Usage

Select a video or video layer, then click **Pluck Frames**.

- **Debug** creates an untouched comp and marks proposed removals.
- **Diagnostic** also marks rejected raw candidates.
- Edit or add layer markers, then click **Pluck Marked Frames** to remove exactly
  those frames.

## ffmpeg

Frame Plucker requires [ffmpeg](https://ffmpeg.org/download.html). If it is not
detected automatically, Frame Plucker asks you to locate the executable.
