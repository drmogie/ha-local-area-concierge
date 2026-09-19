"""Core logic for one Local Area Concierge (one Home Assistant Area).

A ConciergeDevice owns the persistent chat log for its Area, talks to the
conversation agent of the Assist Pipeline it was pointed at, and broadcasts
every change to whoever subscribed (the companion card(s) and the status
sensor).
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import logging
from typing import Any
import uuid

from homeassistant.components import conversation
from homeassistant.components.assist_pipeline.pipeline import (
    Pipeline,
    PipelineNotFound,
    async_get_pipeline,
)
from homeassistant.components.conversation.agent_manager import async_get_agent
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Context, HomeAssistant, callback
from homeassistant.helpers import (
    area_registry as ar,
    device_registry as dr,
    entity_registry as er,
    intent,
)
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    CONF_AREA_ID,
    CONF_AREA_NAME,
    CONF_MAX_MESSAGES,
    CONF_PIPELINE_ID,
    CONF_SCOPE_TO_AREA,
    CONVERSE_TIMEOUT,
    DEFAULT_MAX_MESSAGES,
    DEFAULT_SCOPE_TO_AREA,
    DOMAIN,
    ERROR_TEXT,
    GLOBAL_INTENTS,
    STATUS_ERROR,
    STATUS_IDLE,
    STATUS_THINKING,
    STORAGE_VERSION,
)

_LOGGER = logging.getLogger(__name__)

ConciergeConfigEntry = ConfigEntry["ConciergeDevice"]

EventListener = Callable[[dict[str, Any]], None]


class ConciergeDevice:
    """The chat brain for one Area."""

    def __init__(self, hass: HomeAssistant, entry: ConciergeConfigEntry) -> None:
        """Initialize the concierge."""
        self.hass = hass
        self.entry = entry
        self._store: Store[dict[str, Any]] = Store(
            hass, STORAGE_VERSION, f"{DOMAIN}.{entry.entry_id}"
        )
        self.messages: list[dict[str, Any]] = []
        self.conversation_id: str | None = None
        self.status = STATUS_IDLE
        self._lock = asyncio.Lock()
        self._listeners: list[EventListener] = []

    # ------------------------------------------------------------------ config

    @property
    def area_id(self) -> str:
        """Return the Area this concierge is scoped to."""
        return self.entry.data[CONF_AREA_ID]

    @property
    def area_name(self) -> str:
        """Return the Area's current name (falls back to the name at setup)."""
        area = ar.async_get(self.hass).async_get_area(self.area_id)
        if area is not None:
            return area.name
        return self.entry.data.get(CONF_AREA_NAME) or self.area_id

    @property
    def area_exists(self) -> bool:
        """Return True while the Area still exists."""
        return ar.async_get(self.hass).async_get_area(self.area_id) is not None

    @property
    def pipeline_id(self) -> str:
        """Return the Assist Pipeline id (options override setup data)."""
        return self.entry.options.get(
            CONF_PIPELINE_ID, self.entry.data[CONF_PIPELINE_ID]
        )

    @property
    def max_messages(self) -> int:
        """Return how many messages of history to keep."""
        return int(self.entry.options.get(CONF_MAX_MESSAGES, DEFAULT_MAX_MESSAGES))

    @property
    def scope_to_area(self) -> bool:
        """Return whether this Area's name is auto-appended to messages.

        On by default (the original behavior). Turning it off sends the
        message as-is, so a sentence that names a different Area or entity
        directly ("turn off office chris light") isn't forced into this
        concierge's own Area.
        """
        return bool(
            self.entry.options.get(CONF_SCOPE_TO_AREA, DEFAULT_SCOPE_TO_AREA)
        )

    def get_pipeline(self) -> Pipeline | None:
        """Return the configured pipeline, or None if it no longer exists."""
        try:
            return async_get_pipeline(self.hass, self.pipeline_id)
        except PipelineNotFound:
            return None

    @callback
    def meta(self) -> dict[str, Any]:
        """Return descriptive info about this concierge for the card."""
        pipeline = self.get_pipeline()
        return {
            "entry_id": self.entry.entry_id,
            "title": self.entry.title,
            "area_id": self.area_id,
            "area_name": self.area_name,
            "pipeline_id": self.pipeline_id,
            "pipeline_name": pipeline.name if pipeline else None,
            "has_stt": bool(pipeline and pipeline.stt_engine),
            "has_tts": bool(pipeline and pipeline.tts_engine),
            "available": self._agent_available(pipeline),
            "max_messages": self.max_messages,
            "scope_to_area": self.scope_to_area,
        }

    def _agent_available(self, pipeline: Pipeline | None) -> bool:
        """Return True if the pipeline's conversation agent can be reached."""
        if pipeline is None or not self.area_exists:
            return False
        try:
            agent = async_get_agent(self.hass, pipeline.conversation_engine)
        except Exception:  # noqa: BLE001
            return False
        if agent is None:
            return False
        state = self.hass.states.get(pipeline.conversation_engine)
        return state is None or state.state != "unavailable"

    # ------------------------------------------------------------- persistence

    async def async_load(self) -> None:
        """Load the saved chat log."""
        data = await self._store.async_load()
        if not data:
            return
        messages = data.get("messages")
        if isinstance(messages, list):
            self.messages = [m for m in messages if isinstance(m, dict)]
            self._trim()
        self.conversation_id = data.get("conversation_id")

    @callback
    def _data_to_save(self) -> dict[str, Any]:
        return {"messages": self.messages, "conversation_id": self.conversation_id}

    @callback
    def _schedule_save(self) -> None:
        self._store.async_delay_save(self._data_to_save, 1)

    async def async_close(self) -> None:
        """Flush the chat log and tell listeners this concierge is going away."""
        self._notify({"type": "closed"})
        self._listeners.clear()
        await self._store.async_save(self._data_to_save())

    async def async_remove(self) -> None:
        """Delete the saved chat log (the config entry was removed)."""
        await self._store.async_remove()

    # ---------------------------------------------------------------- listeners

    @callback
    def async_subscribe(self, listener: EventListener) -> Callable[[], None]:
        """Subscribe to chat events. Returns an unsubscribe callable."""
        self._listeners.append(listener)

        @callback
        def _unsub() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return _unsub

    @callback
    def _notify(self, event: dict[str, Any]) -> None:
        for listener in list(self._listeners):
            try:
                listener(event)
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Error in Local Area Concierge listener")

    @callback
    def snapshot(self) -> dict[str, Any]:
        """Return everything a card needs to draw itself."""
        return {
            "type": "snapshot",
            "meta": self.meta(),
            "messages": list(self.messages),
            "status": self.status,
        }

    # ---------------------------------------------------------------- messages

    def _trim(self) -> None:
        limit = self.max_messages
        if len(self.messages) > limit:
            del self.messages[: len(self.messages) - limit]

    @callback
    def _add_message(self, role: str, text: str) -> dict[str, Any]:
        message = {
            "id": uuid.uuid4().hex[:12],
            "role": role,
            "text": text,
            "ts": dt_util.utcnow().isoformat(),
        }
        self.messages.append(message)
        self._trim()
        self._schedule_save()
        self._notify({"type": "message", "message": message})
        return message

    @callback
    def _set_status(self, status: str) -> None:
        self.status = status
        self._notify(
            {
                "type": "status",
                "status": status,
                "available": self._agent_available(self.get_pipeline()),
            }
        )

    async def async_clear(self) -> None:
        """Start fresh: wipe the chat log and the conversation context."""
        async with self._lock:
            self.messages = []
            self.conversation_id = None
            self.status = STATUS_IDLE
            await self._store.async_save(self._data_to_save())
            self._notify({"type": "cleared"})
            self._notify(
                {
                    "type": "status",
                    "status": STATUS_IDLE,
                    "available": self._agent_available(self.get_pipeline()),
                }
            )

    # -------------------------------------------------------------------- send

    async def async_send(
        self,
        text: str,
        context: Context,
        announce_entity: str | None = None,
    ) -> dict[str, Any]:
        """Send one message to this Area's assistant and store the exchange.

        Returns the assistant (or error) message that was added to the log.
        """
        text = text.strip()
        async with self._lock:
            self._add_message("user", text)
            self._set_status(STATUS_THINKING)
            try:
                async with asyncio.timeout(CONVERSE_TIMEOUT):
                    speech = await self._async_process(text, context)
            except Exception:  # noqa: BLE001
                # Covers agent failures, timeouts and a pipeline that was
                # deleted - all of which should show a friendly bubble, never
                # silence.
                _LOGGER.warning(
                    "Local Area Concierge '%s' could not get a reply",
                    self.entry.title,
                    exc_info=True,
                )
                reply = self._add_message("error", ERROR_TEXT)
                self._set_status(STATUS_ERROR)
                return reply

            reply = self._add_message("assistant", speech or "(no response)")
            self._set_status(STATUS_IDLE)

        if announce_entity and speech:
            self.entry.async_create_background_task(
                self.hass,
                self._async_announce(speech, announce_entity),
                f"{DOMAIN}_announce_{self.entry.entry_id}",
            )
        return reply

    async def _async_process(self, text: str, context: Context) -> str:
        """Run a message through the pipeline's agent and return the speech."""
        if not self.area_exists:
            raise RuntimeError(f"Area {self.area_id} no longer exists")

        pipeline = async_get_pipeline(self.hass, self.pipeline_id)
        agent_id = pipeline.conversation_engine
        language = _pipeline_language(pipeline)
        is_local_agent = agent_id == conversation.HOME_ASSISTANT_AGENT
        scope = self.scope_to_area

        # Home Assistant's own agent (and "prefer local intents" pipelines)
        # get the message with the Area appended, so its native Area matching
        # scopes the request: "turn off the lights" -> "... in Office". With
        # scoping turned off, the message goes through untouched, so a
        # sentence naming a different Area/entity can address it directly.
        if is_local_agent or pipeline.prefer_local_intents:
            scoped = (
                await self._async_scope_text(text, language, context)
                if scope
                else text
            )
            result = await self._async_converse(
                scoped, conversation.HOME_ASSISTANT_AGENT, language, context
            )
            if is_local_agent or not _is_no_match(result):
                return _speech(result)

        # Any other agent (an LLM, say) gets the plain message, plus - when
        # scoping is on - a system prompt that keeps it scoped to this Area.
        result = await self._async_converse(
            text,
            agent_id,
            language,
            context,
            extra_system_prompt=(
                f'The user is chatting from the area "{self.area_name}". '
                "Treat requests as being about this area only, unless they "
                "explicitly name somewhere else, and only control or report "
                "on devices and entities in this area."
            )
            if scope
            else None,
        )
        return _speech(result)

    async def _async_converse(
        self,
        text: str,
        agent_id: str,
        language: str,
        context: Context,
        extra_system_prompt: str | None = None,
    ) -> conversation.ConversationResult:
        result = await conversation.async_converse(
            hass=self.hass,
            text=text,
            conversation_id=self.conversation_id,
            context=context,
            language=language,
            agent_id=agent_id,
            extra_system_prompt=extra_system_prompt,
        )
        if result.conversation_id:
            self.conversation_id = result.conversation_id
            self._schedule_save()
        return result

    async def _async_scope_text(
        self, text: str, language: str, context: Context
    ) -> str:
        """Append the Area name so Home Assistant's own Area matching applies."""
        area_name = self.area_name
        if area_name.casefold() in text.casefold():
            return text
        if await self._async_is_global_sentence(text, language, context):
            return text
        return f"{text} in {area_name}"

    async def _async_is_global_sentence(
        self, text: str, language: str, context: Context
    ) -> bool:
        """Return True for whole-house questions (weather, time) with no Area."""
        try:
            agent = async_get_agent(self.hass, conversation.HOME_ASSISTANT_AGENT)
            recognize = getattr(agent, "async_recognize_intent", None)
            if recognize is None:
                return False
            result = await recognize(
                conversation.ConversationInput(
                    text=text,
                    context=context,
                    conversation_id=None,
                    device_id=None,
                    satellite_id=None,
                    language=language,
                    agent_id=conversation.HOME_ASSISTANT_AGENT,
                )
            )
        except Exception:  # noqa: BLE001
            _LOGGER.debug("Could not pre-recognize sentence", exc_info=True)
            return False
        return bool(
            result
            and result.intent.name in GLOBAL_INTENTS
            and not result.unmatched_entities
        )

    # ---------------------------------------------------------------- announce

    async def _async_announce(self, speech: str, media_player: str) -> None:
        """Speak a reply with the pipeline's own TTS engine and voice."""
        pipeline = self.get_pipeline()
        if pipeline is None or not pipeline.tts_engine:
            _LOGGER.debug("Pipeline has no TTS engine; not announcing")
            return
        data: dict[str, Any] = {
            "entity_id": pipeline.tts_engine,
            "media_player_entity_id": media_player,
            "message": speech,
        }
        if pipeline.tts_language:
            data["language"] = pipeline.tts_language
        if pipeline.tts_voice:
            data["options"] = {"voice": pipeline.tts_voice}
        try:
            await self.hass.services.async_call("tts", "speak", data, blocking=True)
        except Exception:  # noqa: BLE001
            _LOGGER.warning(
                "Could not announce reply on %s", media_player, exc_info=True
            )

    # ------------------------------------------------------------- suggestions

    @callback
    def suggestions(self) -> list[str]:
        """Suggest a few things to say, based on what is really in this Area."""
        ent_reg = er.async_get(self.hass)
        dev_reg = dr.async_get(self.hass)

        entities = {
            entry.entity_id: entry
            for entry in er.async_entries_for_area(ent_reg, self.area_id)
        }
        for device in dr.async_entries_for_area(dev_reg, self.area_id):
            for entry in er.async_entries_for_device(ent_reg, device.id):
                if entry.area_id is None:
                    entities.setdefault(entry.entity_id, entry)

        domains: set[str] = set()
        has_temperature = False
        has_humidity = False
        for entry in entities.values():
            if entry.disabled_by or entry.hidden_by:
                continue
            domains.add(entry.domain)
            device_class = entry.device_class or entry.original_device_class
            if entry.domain == "sensor" and device_class == "temperature":
                has_temperature = True
            if entry.domain == "sensor" and device_class == "humidity":
                has_humidity = True

        chips: list[str] = []
        if "light" in domains:
            chips += [
                "Turn on the lights",
                "Turn off the lights",
                "Which lights are on?",
            ]
        if "fan" in domains:
            chips += ["Turn on the fans", "Turn off the fans"]
        if has_temperature or "climate" in domains:
            chips.append("What's the temperature?")
        if has_humidity:
            chips.append("What's the humidity?")
        chips += ["What's the weather?", "What time is it?"]
        return chips


def _pipeline_language(pipeline: Pipeline) -> str:
    """Pick the language the same way Home Assistant's own pipeline does."""
    if pipeline.conversation_language == "*":
        return pipeline.stt_language or pipeline.tts_language or pipeline.language
    return pipeline.conversation_language


def _speech(result: conversation.ConversationResult) -> str:
    """Pull the plain-text speech out of a conversation result."""
    return (result.response.speech.get("plain", {}).get("speech") or "").strip()


def _is_no_match(result: conversation.ConversationResult) -> bool:
    """Return True if Home Assistant's agent did not understand the sentence."""
    response = result.response
    return (
        response.response_type == intent.IntentResponseType.ERROR
        and response.error_code == intent.IntentResponseErrorCode.NO_INTENT_MATCH
    )
