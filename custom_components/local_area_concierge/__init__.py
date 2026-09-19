"""The Local Area Concierge integration.

One config entry per Home Assistant Area. Each entry pairs an Area with one of
your existing Assist Pipelines and keeps a persistent chat log for it. The
companion Lovelace card ships inside this integration and registers itself,
so there is no separate Lovelace resource to add.
"""

from __future__ import annotations

from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.device_registry import DeviceEntryType
from homeassistant.helpers.typing import ConfigType

from .concierge import ConciergeConfigEntry, ConciergeDevice
from .const import CARD_URL, CARD_VERSION, DOMAIN, PLATFORMS, STATIC_URL_ROOT
from .websocket_api import async_register_websocket_commands


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the card and the websocket API once, however many Areas exist.

    async_setup runs exactly once per Home Assistant start (unlike
    async_setup_entry, which runs once per config entry and concurrently), so
    one-time registrations are safe here without any locking.
    """
    www_dir = Path(__file__).parent / "www"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_URL_ROOT, str(www_dir), True)]
    )
    add_extra_js_url(hass, f"{CARD_URL}?v={CARD_VERSION}")
    async_register_websocket_commands(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConciergeConfigEntry) -> bool:
    """Set up one Area's concierge."""
    device = ConciergeDevice(hass, entry)
    await device.async_load()
    entry.runtime_data = device

    # Register the device, and (only the first time) place it in its Area.
    dev_reg = dr.async_get(hass)
    identifiers = {(DOMAIN, entry.entry_id)}
    is_new = dev_reg.async_get_device(identifiers=identifiers) is None
    device_entry = dev_reg.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers=identifiers,
        name=entry.title,
        manufacturer="Local Area Concierge",
        model="Area Concierge",
        entry_type=DeviceEntryType.SERVICE,
    )
    if is_new and device.area_exists:
        dev_reg.async_update_device(device_entry.id, area_id=device.area_id)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConciergeConfigEntry) -> bool:
    """Unload one Area's concierge."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        await entry.runtime_data.async_close()
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: ConciergeConfigEntry) -> None:
    """Delete the saved chat log when the entry is removed."""
    await ConciergeDevice(hass, entry).async_remove()
