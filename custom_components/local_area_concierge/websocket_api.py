"""WebSocket API used by the Local Area Concierge card."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv

from .concierge import ConciergeDevice
from .const import (
    DOMAIN,
    WS_CLEAR,
    WS_LIST,
    WS_SEND,
    WS_STATUS,
    WS_SUBSCRIBE,
    WS_SUGGESTIONS,
)

MAX_TEXT_LENGTH = 2000


@callback
def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register this integration's websocket commands. Call exactly once."""
    websocket_api.async_register_command(hass, ws_list)
    websocket_api.async_register_command(hass, ws_status)
    websocket_api.async_register_command(hass, ws_subscribe)
    websocket_api.async_register_command(hass, ws_send)
    websocket_api.async_register_command(hass, ws_clear)
    websocket_api.async_register_command(hass, ws_suggestions)


@callback
def _get_device(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> ConciergeDevice | None:
    """Find a loaded concierge by config entry id, or reply with an error."""
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if (
        entry is None
        or entry.domain != DOMAIN
        or entry.state.value != "loaded"
        or not hasattr(entry, "runtime_data")
    ):
        connection.send_error(
            msg["id"], websocket_api.ERR_NOT_FOUND, "Concierge not found or not loaded"
        )
        return None
    return entry.runtime_data


@websocket_api.websocket_command({vol.Required("type"): WS_LIST})
@callback
def ws_list(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """List every loaded concierge (used by the card editor)."""
    connection.send_result(
        msg["id"],
        [
            entry.runtime_data.meta()
            for entry in hass.config_entries.async_loaded_entries(DOMAIN)
        ],
    )


@websocket_api.websocket_command(
    {vol.Required("type"): WS_STATUS, vol.Required("entry_id"): str}
)
@callback
def ws_status(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Return fresh info about one concierge (reachability etc.)."""
    if (device := _get_device(hass, connection, msg)) is not None:
        connection.send_result(msg["id"], device.meta())


@websocket_api.websocket_command(
    {vol.Required("type"): WS_SUBSCRIBE, vol.Required("entry_id"): str}
)
@callback
def ws_subscribe(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Subscribe a card to one concierge's chat events.

    The first event is always a full snapshot (meta + saved history), so a
    card that just loaded, reloaded, or reconnected starts from the real log.
    """
    if (device := _get_device(hass, connection, msg)) is None:
        return

    @callback
    def forward(event: dict[str, Any]) -> None:
        connection.send_message(websocket_api.event_message(msg["id"], event))

    connection.subscriptions[msg["id"]] = device.async_subscribe(forward)
    connection.send_result(msg["id"])
    forward(device.snapshot())


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_SEND,
        vol.Required("entry_id"): str,
        vol.Required("text"): vol.All(str, vol.Length(min=1, max=MAX_TEXT_LENGTH)),
        vol.Optional("announce_entity"): cv.entity_domain("media_player"),
    }
)
@websocket_api.async_response
async def ws_send(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Send a message to an Area's assistant and wait for the reply."""
    if (device := _get_device(hass, connection, msg)) is None:
        return
    if not msg["text"].strip():
        connection.send_error(msg["id"], websocket_api.ERR_INVALID_FORMAT, "Empty text")
        return
    reply = await device.async_send(
        msg["text"], connection.context(msg), msg.get("announce_entity")
    )
    connection.send_result(msg["id"], {"message": reply})


@websocket_api.websocket_command(
    {vol.Required("type"): WS_CLEAR, vol.Required("entry_id"): str}
)
@websocket_api.async_response
async def ws_clear(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Wipe the chat log and start a fresh conversation."""
    if (device := _get_device(hass, connection, msg)) is None:
        return
    await device.async_clear()
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {vol.Required("type"): WS_SUGGESTIONS, vol.Required("entry_id"): str}
)
@callback
def ws_suggestions(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Return suggested prompts built from what is really in the Area."""
    if (device := _get_device(hass, connection, msg)) is not None:
        connection.send_result(msg["id"], device.suggestions())
