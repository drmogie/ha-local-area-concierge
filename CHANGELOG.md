# Changelog

## 2026.09.19.06
- The card's status line now shows the Area name too, alongside the Assist Pipeline (e.g. "Ready · Home Assistant · Office: Mogie"), not just the pipeline. Same addition to the hover tooltip.

## 2026.09.19.05
- Added a real brand icon/logo (a concierge holding the Home Assistant logo), replacing the placeholder generated during the initial build. `icon.png`/`icon@2x.png` are cropped tight to the head/cap/bow-tie for legibility at the small size Home Assistant renders integration icons at; `logo.png`/`logo@2x.png` keep the full figure.
- Fixed: the previous release (`.04`) bumped the backend's `CARD_VERSION` (`const.py`/`manifest.json`) but missed the card's own matching JS constant, leaving it out of lockstep at `2026.09.19.03`. Brought it back in sync.

## 2026.09.19.04
- Fixed: messages sent through a concierge never told the conversation agent which device (and therefore which Area) they came from - `conversation.async_converse` was called without a `device_id`, even though Home Assistant supports one. This meant any device/satellite-aware sentence trigger (like a phrase-router style "whichever room heard it" rule) couldn't tell concierges apart, no matter which Area's concierge you were chatting through. Each concierge now passes its own device's ID, the same way a real voice satellite would.

## 2026.09.19.03
- Added a **Scope messages to this Area** option (Configure → options, on by default). Turn it off to send a message as-is, with no Area name added, so a sentence naming a different Area or entity directly (e.g. "turn off office chris light" typed into a different Area's chat) can address it instead of always being forced onto this concierge's own Area.
- The card's status line now shows the Assist Pipeline in use right next to "Ready" (e.g. "Ready · Home Assistant"), not just as a hover tooltip.
- Fixed: the "New conversation" (broom) button cleared the chat log but left whatever you'd typed sitting in the message box. It now clears the input too.

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
