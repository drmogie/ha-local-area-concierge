# Local Area Concierge — Layout Plan

*Last updated: 2026-09-19*

## Integration (backend)

- Custom Home Assistant integration, one config-flow device per HA Area (native HA concept, not a made-up room)
- Opt-in, not automatic - not every Area needs a device
- Setup flow: Settings > Add Integration > pick an existing HA Area from a dropdown, then pick one of your existing HA Assist Pipelines (Settings > Voice assistants) for that device > name it
- Each device is scoped only to the entities Home Assistant already has assigned to that Area
- Request/response mechanism - decided: use HA's built-in Assist Pipelines. Each Area device picks an existing pipeline (via assist_pipeline.async_get_pipelines), which already bundles a conversation agent, STT, TTS engine/voice, wake word, and language. The integration calls conversation.async_converse using that pipeline's agent_id, so different Areas can use different agents/voices with no extra config UI beyond the dropdown - just pointing at what's already set up in HA.
- Area-scoping - tested directly against a real HA instance (ha-pi4): conversation.process does NOT accept an arbitrary device's device_id. It's filtered to genuine Assist satellite devices only - passing any regular device (confirmed with an actual device from a real Area) fails outright ("not a valid option at 'device_id'. Got None"), and the service's documented parameters in this HA version don't list device_id at all. Decided: skip device_id entirely and prepend the Area's own name onto the message text before calling conversation.async_converse ("turn off the lights" becomes "turn off the lights in Office: Mogie"), letting HA's own native area-matching handle the rest - no custom entity filtering code needed.
- Conversation continuity: the AI keeps context between messages the same way a native HA Assist conversation does (reusing a conversation_id across turns), rather than treating every message as an isolated one-shot request.

## Card (companion Lovelace card)

- Chat-style view, one per Area device
- Text input to send a message to that Area's AI
- Message history shown as chat bubbles:
  - AI responses - left-aligned
  - Your messages - right-aligned
  - Each in its own bordered box
  - Background color independently configurable per side (yours vs. AI's), via a color picker in the editor
  - Checkbox per side to make that bubble's background transparent instead, overriding the color picker
  - Border show/hide toggle - lets the bubble border be turned off entirely
  - Time/date stamp shown on every bubble
- Chat log is persistent - survives a browser reload and a full Home Assistant restart. Settled approach: backend stores the message list via HA's `Store` helper (`homeassistant.helpers.storage.Store`), trimmed to the last N messages (pairs with the Auto-trim history idea below) so it doesn't grow forever; the card fetches that stored history from the integration on load (a websocket command) rather than starting blank and only showing new messages
- Full GUI config editor, per standing convention for all cards

## Optional TTS tie-in

- Card editor: pick a target media_player entity (e.g. a Piper Browser Speaker device) for that Area
- Once a media player is selected, an "Announce AI replies" toggle appears in the editor - hidden until a media player is chosen, same show-only-relevant-fields pattern used elsewhere
- Off by default - not forced on every Area device
- When enabled, the AI's reply is spoken aloud through that media player using the TTS voice from the Area device's chosen Assist Pipeline - no separate TTS engine/voice picker needed
- The same toggle also appears directly on the card face, not just in the editor, so it can be flipped without opening config
- Editor's setting is the persistent/master default; a flip on the card face itself is temporary - resets back to that saved default on a page refresh

## Usability enhancements

- Suggested-prompt chips: quick-tap buttons pulled from that Area's actual entities (e.g. "Turn off lights", "What's the temp?") - shown in a popup opened from the card, not on the main card face, so they don't clutter the display
- Typing/thinking indicator - animated dots while waiting on the AI's response, so the card doesn't look frozen mid-round-trip
- Mic button next to the text input - lets you speak instead of type, using the Assist Pipeline's own STT. Only shown when that Area device's chosen pipeline actually has an STT engine set (checked via the pipeline config) - hidden otherwise, since not every pipeline has one (e.g. the default "Home Assistant" pipeline currently has STT: None)
- Friendly error bubble - shows "Couldn't reach the assistant" instead of silence if the pipeline/agent fails or times out
- New conversation / clear-history button - resets the conversation_id and wipes the visible chat log, an intentional way to start fresh
- Connection/status indicator - small dot or label showing whether that Area's pipeline is actually reachable, so "nothing happened" doesn't leave you guessing
- Relative timestamps - "2 min ago" for recent messages, full date/time once a message is older
- Auto-trim history - configurable max message count so the persistent log doesn't grow forever; oldest messages quietly drop off

## Not yet decided

- [x] Repo/domain naming - decided: Local Area Concierge (repo/domain: local_area_concierge)
- [x] Conversation agent - resolved: Phase 1 sticks with basic HA intents only (turn on/off lights, current temperature, weather, etc.) via the built-in "Home Assistant" conversation agent - no LLM needed yet, and both existing pipelines already work for this. General open-ended Q&A ("what's 2+2", trivia, etc.) is explicitly out of scope for now. A real LLM/AI conversation agent is a later phase, added once basic actions are working end-to-end
