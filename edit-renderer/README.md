# Edit+ renderer

Edit+ rendering engine. The AI/editor produces versioned JSON decisions; this package executes them with Remotion.

## Input contract

```json
{
  "sourceUrl": "https://signed-private-video-url",
  "style": "codie",
  "captionPreset": "modern_bold",
  "accentColor": "#d7ff3f",
  "timeline": {
    "version": 1,
    "segments": [
      {
        "sourceStartMs": 8400,
        "sourceEndMs": 11800,
        "crop": "close",
        "positionX": 50,
        "positionY": 48,
        "transition": "cut",
        "reason": "Narrative punch-in"
      }
    ],
    "captions": [
      {
        "text": "Example caption",
        "startMs": 0,
        "endMs": 1400,
        "timestampMs": 0,
        "confidence": 0.98
      }
    ],
    "overlays": []
  }
}
```

The first renderer deliberately prioritizes reliability: hard cuts, source trims, narration-driven punch-ins, caption presets and explicit overlays. More transitions and sound design are added as timeline primitives rather than hidden model behavior.

## Render

`node src/render.mjs --input props.json --output output.mp4`

The command emits machine-readable bundle/render progress so the durable job can store real UI progress.
