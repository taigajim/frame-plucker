# Frame Plucker

After Effects script that removes duplicated frames from AI-generated video.

Seedance often outputs 24 fps files where some frames are repeats of the previous frame, which makes motion stutter. Frame Plucker uses ffmpeg to measure frame-to-frame differences, finds the repeated frames, and builds a new comp without them. Your original footage is not modified.

## Requirements

- Adobe After Effects
- [ffmpeg](https://ffmpeg.org/download.html)

The script finds ffmpeg automatically from PATH or common install locations. If it can't, it asks you to locate the file once and remembers your choice.

## Setup

1. Open Scripting & Expressions (After Effects > Settings on Mac, Edit > Preferences on Windows).
2. Enable "Allow Scripts to Write Files and Access Network".

## Usage

1. Select a video in the Project panel, or select its layer in a comp.
2. Run `frame-plucker.jsx` (File > Scripts > Run Script File).
3. If the script asks for confirmation, check what it found and click OK.

That's it. If the clip has no duplicated frames, the script says so and creates nothing.

## What it detects

- Steady patterns, every nth frame repeated
- Patterns that drift over the length of the clip
- A few scattered held frames with no pattern

## License

MIT
