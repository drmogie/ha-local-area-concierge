"""Config flow for Local Area Concierge.

Pick an existing Area, pick one of your existing Assist Pipelines, name it.
No YAML, and nothing is created automatically for Areas you don't opt in.
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components.assist_pipeline import async_get_pipelines
from homeassistant.components.assist_pipeline.pipeline import (
    PipelineNotFound,
    async_get_pipeline,
)
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlowWithReload,
)
from homeassistant.const import CONF_NAME
from homeassistant.core import callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers.selector import (
    AreaSelector,
    BooleanSelector,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)

from .const import (
    CONF_AREA_ID,
    CONF_AREA_NAME,
    CONF_MAX_MESSAGES,
    CONF_PIPELINE_ID,
    CONF_SCOPE_TO_AREA,
    DEFAULT_MAX_MESSAGES,
    DEFAULT_SCOPE_TO_AREA,
    DOMAIN,
    MAX_MAX_MESSAGES,
    MIN_MAX_MESSAGES,
)


def _pipeline_selector(hass) -> SelectSelector:
    """Build a dropdown of the user's existing Assist Pipelines."""
    return SelectSelector(
        SelectSelectorConfig(
            options=[
                SelectOptionDict(value=pipeline.id, label=pipeline.name)
                for pipeline in async_get_pipelines(hass)
            ],
            mode=SelectSelectorMode.DROPDOWN,
        )
    )


class LocalAreaConciergeConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Local Area Concierge."""

    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlowWithReload:
        """Return the options flow."""
        return LocalAreaConciergeOptionsFlow()

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Pick the Area and the Assist Pipeline for this concierge."""
        if not async_get_pipelines(self.hass):
            return self.async_abort(reason="no_pipelines")

        errors: dict[str, str] = {}
        if user_input is not None:
            area_id = user_input[CONF_AREA_ID]
            area = ar.async_get(self.hass).async_get_area(area_id)
            if area is None:
                errors[CONF_AREA_ID] = "area_not_found"
            elif any(
                entry.unique_id == area_id for entry in self._async_current_entries()
            ):
                errors[CONF_AREA_ID] = "area_taken"
            else:
                await self.async_set_unique_id(area_id)
                self._abort_if_unique_id_configured()
                title = (user_input.get(CONF_NAME) or "").strip() or (
                    f"{area.name} Concierge"
                )
                return self.async_create_entry(
                    title=title,
                    data={
                        CONF_AREA_ID: area_id,
                        CONF_AREA_NAME: area.name,
                        CONF_PIPELINE_ID: user_input[CONF_PIPELINE_ID],
                    },
                )

        try:
            preferred = async_get_pipeline(self.hass).id
        except PipelineNotFound:
            preferred = None

        schema = vol.Schema(
            {
                vol.Required(CONF_AREA_ID): AreaSelector(),
                vol.Required(
                    CONF_PIPELINE_ID,
                    **({"default": preferred} if preferred else {}),
                ): _pipeline_selector(self.hass),
                vol.Optional(CONF_NAME): str,
            }
        )
        return self.async_show_form(
            step_id="user",
            data_schema=self.add_suggested_values_to_schema(schema, user_input),
            errors=errors,
        )


class LocalAreaConciergeOptionsFlow(OptionsFlowWithReload):
    """Change the pipeline or history size after setup."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Manage the options."""
        if user_input is not None:
            return self.async_create_entry(
                data={
                    CONF_PIPELINE_ID: user_input[CONF_PIPELINE_ID],
                    CONF_MAX_MESSAGES: int(user_input[CONF_MAX_MESSAGES]),
                    CONF_SCOPE_TO_AREA: user_input[CONF_SCOPE_TO_AREA],
                }
            )

        entry = self.config_entry
        current_pipeline = entry.options.get(
            CONF_PIPELINE_ID, entry.data[CONF_PIPELINE_ID]
        )
        known = {pipeline.id for pipeline in async_get_pipelines(self.hass)}
        pipeline_key = (
            vol.Required(CONF_PIPELINE_ID, default=current_pipeline)
            if current_pipeline in known
            else vol.Required(CONF_PIPELINE_ID)
        )
        schema = vol.Schema(
            {
                pipeline_key: _pipeline_selector(self.hass),
                vol.Required(
                    CONF_MAX_MESSAGES,
                    default=entry.options.get(CONF_MAX_MESSAGES, DEFAULT_MAX_MESSAGES),
                ): NumberSelector(
                    NumberSelectorConfig(
                        min=MIN_MAX_MESSAGES,
                        max=MAX_MAX_MESSAGES,
                        step=1,
                        mode=NumberSelectorMode.BOX,
                    )
                ),
                vol.Required(
                    CONF_SCOPE_TO_AREA,
                    default=entry.options.get(
                        CONF_SCOPE_TO_AREA, DEFAULT_SCOPE_TO_AREA
                    ),
                ): BooleanSelector(),
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
