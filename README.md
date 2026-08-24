# Slopsmith Plugin: Drum Highway

![Drum Highway](screenshot.png)

A plugin for [Slopsmith](https://github.com/got-feedback/feedback) that replaces the guitar highway with a lane-based drum view, with MIDI drum pad input and a built-in drum kit synthesizer.

## Features

- **Lane-based drum highway** — 8 horizontal lanes (Hi-Hat, Snare, Tom 1-3, Crash, Ride, Kick) with notes scrolling right to left
- **Kick drum full-width bars** — kick hits render as wide horizontal bars spanning the highway, like open string notes on the guitar highway
- **Distinct note shapes** — circles for toms/snare, diamonds for cymbals, X shapes for hi-hat, full bars for kick
- **Hi-hat variations** — closed (filled X), pedal (small X at bottom), open (ring with "o" inside)
- **Neon glow effects** — each drum piece has a unique color with multi-layer glow
- **Velocity-based sizing** — louder hits are bigger, ghost notes are smaller
- **Auto-activate** — switches on automatically for Drums/Percussion arrangements
- **MIDI drum pad input** — connect any MIDI drum pad, electronic kit, or controller via Web MIDI API
- **Custom MIDI mapping** — Settings → MIDI Learn assigns pads on a MIDI device; the Drums tab attaches a profile to that device
- **Built-in drum sounds** — WebAudioFont-powered GM drum kit playback on MIDI hit
- **Accuracy scoring** — hit detection with tight +/-50ms timing window, accuracy %, streak counter
- **Drum settings editor** — named profile, attach a MIDI device, and highway lanes in Settings → Drums (same editor from the in-song gear)

## Drum Lanes

| Lane | Label | MIDI Notes | Color | Shape |
|------|-------|-----------|-------|-------|
| Hi-Hat | HH | 42, 44, 46 | Blue | X |
| Snare | Sn | 38, 40 | Yellow | Circle |
| Tom 1 | T1 | 48, 50 | Green | Square |
| Tom 2 | T2 | 45, 47 | Orange | Circle with center dot |
| Tom 3 | T3 | 41, 43 | Purple | Square with center mark |
| Crash | Cr | 49, 57 | Cyan | Diamond |
| Ride | Ri | 51, 59 | White | Hexagon |
| Kick | Ki | 35, 36 | Red | Full-width bar |

## Requirements

- **Chrome or Edge** for MIDI drum pad input (Firefox does not support Web MIDI)
- MIDI features are optional — the drum view works without a MIDI controller

## Installation

```bash
cd /path/to/slopsmith/plugins
git clone https://github.com/got-feedback/feedback-plugin-drums.git drums
docker compose restart
```

A "Drums" button will appear in the player controls when you play a song. The gear opens the same Drum settings editor as Settings → Drums (profile, attach MIDI device, highway lanes). Mapping and MIDI knobs live on Settings → MIDI. Only one editor instance is mounted at a time.

## How It Works

The plugin reads note data from the highway renderer and maps them to drum lanes. Notes use the MIDI encoding convention `midi = string * 24 + fret`, which the [editor plugin](https://github.com/got-feedback/feedback-plugin-editor) uses when importing drum tracks from Guitar Pro files.

### MIDI Drum Pad

Connect a USB MIDI drum pad or electronic kit, configure it on Settings → MIDI, then attach that device on Settings → Drums. Play along and get real-time visual feedback:

- **Lane flash** — the lane lights up when you hit the correct drum piece
- **Green notes** — correctly hit notes within the timing window
- **Red flash** — wrong drum piece or no matching note
- **Gray notes** — missed notes that passed the now line

### Custom Mapping

Different drum pads send different MIDI note numbers. Map them on **Settings → MIDI** (device type, Learn table, channel / hits / volume). The Drums tab only attaches a named profile to an existing MIDI device and configures highway lanes.

1. Create or select a MIDI device on Settings → MIDI and Learn the pad map there
2. Open Drum settings (Settings → Drums, or the in-song gear)
3. Attach that MIDI device to the active drum profile
4. Scoring uses the attached device's `notes`. An empty attach leaves hits unmapped; the highway still plays

A profile never stores a copy of the note map. `device_id` is the attach pointer.

## License

MIT
