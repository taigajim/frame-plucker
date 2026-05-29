# Frame Plucker

After Effects script for removing repeated held frames from AI-generated video, especially Seedance clips with cadence stutter.

The script uses `ffmpeg` to analyse frame-to-frame motion, detects repeated low-motion phases, and creates a shortened clean comp with those frames removed. You can then render or retime that clean comp as needed.

## Requirements

- Adobe After Effects
- `ffmpeg` installed and available from PATH, or selected manually in the script dialog

Download ffmpeg: [ffmpeg.org/download.html](https://ffmpeg.org/download.html)

## After Effects Setup

Enable scripting access:

1. Open `After Effects > Settings` or `Preferences`.
2. Go to `Scripting & Expressions`.
3. Turn on `Allow Scripts to Write Files and Access Network`.

## Usage

1. Select the footage in the Project panel, or open/select a comp containing the footage.
2. Run `frame-plucker.jsx`.
3. Check the selected source and ffmpeg path.
4. Click `Pluck`.

The script creates a new clean comp. It does not overwrite the original footage.

## Notes

If the start of a clip is black or nearly static, the script searches forward for a better analysis window. If the motion is too flat for reliable detection, it will stop rather than guessing.

## License

MIT
