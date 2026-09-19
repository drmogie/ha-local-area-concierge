# Changelog

## 2026.09.19.02
- Fixed a deprecation warning logged on every setup: switched device lookup from `device_registry.async_get_device` (deprecated, identifiers/connections are no longer unique across config entries) to `async_get_device_by_identifier`, which is unambiguous per config entry. No behavior change.

## 2026.09.19.01
- Initial release.
- Integration: one config entry per Home Assistant Area (opt-in). Pick an Area, pick one of your existing Assist Pipelines, name it. Options let you change the pipeline later and set how many messages of history to keep.
- Requests are scoped to the Area: for Home Assistant's own conversation agent (and "prefer local intents" pipelines) the Area name is appended to the message so Home Assistant's native Area matching does the rest. Whole-house questions (weather, time) are left alone. Any other agent (an LLM) gets the plain message plus a system prompt that keeps it scoped to the Area.
- The chat keeps context between messages like a native Assist conversation and is saved with Home Assistant's `Store`, so it survives a browser reload and a Home Assistant restart. Oldest messages drop off past the configured limit.
- Each concierge is a device (placed in its Area) with a `Status` sensor (idle / thinking / error).
- Companion Lovelace card (Sections layout, full GUI editor, registers itself): chat bubbles (yours on the right, the assistant's on the left), per-side bubble color or transparent background, border on/off, relative timestamps, typing indicator, friendly error bubble, two-tap "new conversation" button, connection/status dot, suggested prompts popup built from what is really in the Area, and a mic button (only when the Area's pipeline has a speech-to-text engine).
- Optional spoken replies through any media player (for example Piper Browser Speaker) using the TTS voice of the Area's Assist Pipeline. Off by default; the same toggle is on the card face and resets to the saved default on a page refresh.
