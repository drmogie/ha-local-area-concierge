# Local Area Concierge

A Home Assistant integration that gives any Area its own AI-driven "device" — pick an Area, pick one of your existing Assist Pipelines, and get a companion chat card you can type to, scoped to just that Area.

## Features

- One config-flow device per HA Area — opt-in, not created automatically for every Area
- Each device is scoped to that Area only: requests are matched against that Area's own entities (no cross-Area leakage)
- Uses your existing Home Assistant Assist Pipelines — no separate agent/voice setup, just point at what you already have configured
- Companion Lovelace chat card: your messages and the AI's replies as bubbles, independently themeable per side, persistent history across reloads and restarts
- Suggested prompts (from what's really in the Area), typing indicator, friendly error bubble, "new conversation" button, status dot, relative timestamps, and a mic button when the pipeline has speech-to-text
- Optional: have replies spoken aloud through a media player (e.g. [Piper Browser Speaker](https://github.com/drmogie/ha-piper-browser-speaker)), using that Area's own Assist Pipeline voice

## Current scope (Phase 1)

Right now this handles **basic actions and status only** — things like "turn off the lights," "what's the temperature," "what's the weather." It uses the built-in Home Assistant conversation agent (intent matching), so it does **not** answer general questions ("what's 2+2", trivia, etc.) yet. A real LLM-backed conversation agent is a planned later phase, once the basics are working end-to-end.

If you point an Area at a pipeline whose agent is an LLM, the integration already works with it: Home Assistant's own intents are tried first when the pipeline says "prefer local intents", and anything else goes to the LLM with a system prompt that keeps it scoped to the Area.

## Installation

### HACS

[![Open your Home Assistant instance and open a repository inside HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=drmogie&repository=ha-local-area-concierge&category=integration)

Add this repository to HACS (category: Integration), install, then restart Home Assistant.

### Manual

1. Copy the `custom_components/local_area_concierge` folder into your Home Assistant `custom_components` directory.
2. Restart Home Assistant.
3. The companion card registers itself automatically — no separate Lovelace resource to add.

## Configuration

1. Go to **Settings → Devices & services → Add Integration** and search for **Local Area Concierge**.
2. Pick an existing **Area**.
3. Pick one of your existing **Assist Pipelines** (Settings → Voice assistants) for this device.
4. Name it and finish.

Add the **Local Area Concierge Card** to a dashboard (it works great in a Sections view) and pick the new Concierge in the GUI editor to start chatting. The **Configure** button on the integration lets you change the pipeline later, set how many messages of history to keep (default 100), and turn off **Scope messages to this Area** if you'd rather type the Area/entity name yourself instead of having it added automatically.

### Optional: spoken replies

In the card's editor, pick a target media player. Once one is selected, an **Announce AI replies** toggle appears — off by default. When enabled, replies are spoken through that media player using the TTS voice from the Area's chosen Assist Pipeline. The speaker button on the card face flips it temporarily; a page refresh returns to the editor's saved setting.

## Notes and troubleshooting

- **Mic button missing:** it only shows when the Area's Assist Pipeline has a speech-to-text engine, and browsers only allow microphone access on `https://` pages (or `localhost`).
- **Conversation memory:** the AI keeps context between messages the same way a native Assist conversation does, which means Home Assistant's own 5-minute chat-session timeout applies to what an LLM remembers. The chat you see on the card is kept much longer.
- **Two ways to clear:** the broom button on the card wipes the visible chat and starts a fresh conversation (tap it twice).
- **Card doesn't show up / "Custom element doesn't exist":** the card is only registered once at least one Concierge exists. Add one, then hard-refresh the dashboard (Ctrl+Shift+R).

## License

MIT © drmogie
