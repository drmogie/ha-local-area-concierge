"""Constants for the Local Area Concierge integration."""

from homeassistant.const import Platform

DOMAIN = "local_area_concierge"
PLATFORMS = [Platform.SENSOR]

# Config entry data / options keys
CONF_AREA_ID = "area_id"
CONF_AREA_NAME = "area_name"
CONF_PIPELINE_ID = "pipeline_id"
CONF_MAX_MESSAGES = "max_messages"
CONF_SCOPE_TO_AREA = "scope_to_area"

DEFAULT_MAX_MESSAGES = 100
MIN_MAX_MESSAGES = 10
MAX_MAX_MESSAGES = 1000
# On by default: this is the original, only behavior. Turning it off lets a
# message name a different Area/entity directly instead of always being
# scoped to this concierge's own Area.
DEFAULT_SCOPE_TO_AREA = True

# The companion card ships inside the integration. The whole www/ folder is
# registered as one static directory so future assets need no extra routes.
CARD_FILENAME = "ha-local-area-concierge-card.js"
STATIC_URL_ROOT = f"/{DOMAIN}"
CARD_URL = f"{STATIC_URL_ROOT}/{CARD_FILENAME}"
# Keep in lockstep with manifest.json "version" and the card's CARD_VERSION.
CARD_VERSION = "2026.09.19.03"

STORAGE_VERSION = 1

# How long one message may wait on the conversation agent (LLMs can be slow).
CONVERSE_TIMEOUT = 60

# Text shown in the chat when the pipeline/agent fails or times out.
ERROR_TEXT = "Couldn't reach the assistant"

# Status values (also the state of the status sensor)
STATUS_IDLE = "idle"
STATUS_THINKING = "thinking"
STATUS_ERROR = "error"

# Built-in (Home Assistant) intents that are about the whole house, not an
# Area. For these the Area name is NOT appended to the message.
GLOBAL_INTENTS = frozenset(
    {
        "HassGetWeather",
        "HassGetCurrentTime",
        "HassGetCurrentDate",
        "HassNevermind",
    }
)

# Websocket command types
WS_LIST = f"{DOMAIN}/list"
WS_STATUS = f"{DOMAIN}/status"
WS_SUBSCRIBE = f"{DOMAIN}/subscribe"
WS_SEND = f"{DOMAIN}/send"
WS_CLEAR = f"{DOMAIN}/clear"
WS_SUGGESTIONS = f"{DOMAIN}/suggestions"
