"""Status sensor for a Local Area Concierge."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .concierge import ConciergeConfigEntry, ConciergeDevice
from .const import DOMAIN


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConciergeConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add the status sensor."""
    async_add_entities([ConciergeStatusSensor(entry)])


class ConciergeStatusSensor(SensorEntity):
    """Shows whether the concierge is idle, thinking or failed its last request."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_name = "Status"
    _attr_icon = "mdi:message-text-outline"

    def __init__(self, entry: ConciergeConfigEntry) -> None:
        """Initialize the sensor."""
        self._device: ConciergeDevice = entry.runtime_data
        self._attr_unique_id = f"{entry.entry_id}_status"
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, entry.entry_id)})

    async def async_added_to_hass(self) -> None:
        """Follow the concierge's events."""
        self.async_on_remove(self._device.async_subscribe(self._handle_event))

    @callback
    def _handle_event(self, event: dict[str, Any]) -> None:
        if event["type"] in ("message", "status", "cleared"):
            self.async_write_ha_state()

    @property
    def native_value(self) -> str:
        """Return idle / thinking / error."""
        return self._device.status

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return details about the Area and the last exchange."""
        meta = self._device.meta()
        messages = self._device.messages
        last_reply = next(
            (m["text"] for m in reversed(messages) if m["role"] == "assistant"),
            None,
        )
        return {
            "area_id": meta["area_id"],
            "area_name": meta["area_name"],
            "pipeline_id": meta["pipeline_id"],
            "pipeline_name": meta["pipeline_name"],
            "message_count": len(messages),
            "last_reply": last_reply[:500] if last_reply else None,
            "last_activity": messages[-1]["ts"] if messages else None,
        }
