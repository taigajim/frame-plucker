# Frame Plucker

After Effects panel that removes duplicated frames from AI-generated video.

Seedance and similar tools often output 24 fps files where some frames are repeats
of the previous frame, which makes motion stutter. Frame Plucker uses ffmpeg to
measure frame-to-frame differences, finds the repeated frames, and builds a new
comp without them. Your original footage is not modified.

## Install

1. Unzip the Frame Plucker download somewhere you can find again.
2. In After Effects: File > Scripts > Install ScriptUI Panel, then pick
   `frame-plucker.jsx` from the unzipped folder. Restart After Effects when asked.
3. Open Settings > Scripting & Expressions (After Effects > Settings on Mac,
   Edit > Preferences on Windows) and enable "Allow Scripts to Write Files and
   Access Network".

The panel now appears under the Window menu. Dock it wherever you like.

## Usage

1. Window > Frame Plucker to open the panel.
2. Select a video in the Project panel, or select its layer in a comp.
3. Click Pluck Frames.

If the clip has no duplicated frames, the panel says so and creates nothing.

Keep **Verify candidates at full resolution** enabled for normal use. Frame
Plucker first runs a fast low-resolution scan, then uses a slower full-resolution
comparison only when that scan finds frames it might remove. This second pass
helps distinguish true held frames from intentional slow movement.

Debug mode creates an untouched comp with markers showing the frames that would
be removed.

## ffmpeg

Frame Plucker needs ffmpeg. It uses one you already have on your system first, and
only falls back to a bundled copy if it finds none.

- If ffmpeg is on your PATH or in a common install location, that one is used.
- Otherwise the bundled ffmpeg is set up automatically the first time you pluck.
  On Mac this includes fixing file permissions and clearing the download
  quarantine. Nothing is installed system-wide; the copy lives in your user data
  folder.
- If both fail, the panel asks you to locate ffmpeg once and remembers it.

The bundle ships an arm64 ffmpeg for Apple Silicon Macs and an x86-64 ffmpeg for
Windows. On an Intel Mac without its own ffmpeg, install ffmpeg (for example with
Homebrew) and Frame Plucker will use it.

## What it detects

- Steady patterns, every nth frame repeated
- Patterns that drift over the length of the clip
- A few scattered held frames with no pattern

## Licensing

Frame Plucker is MIT licensed (see `LICENSE`).

The bundled ffmpeg binaries are separate programs that Frame Plucker runs as an
external process. They keep their own licenses: the Mac binary is GPL v3 and the
Windows binary is LGPL v3. Full license texts, version details, and a written
offer for the corresponding source are in the `licenses/` folder.
