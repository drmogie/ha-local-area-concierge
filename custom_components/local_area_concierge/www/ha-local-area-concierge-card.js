/**
 * Local Area Concierge Card
 *
 * Chat-style companion card for the Local Area Concierge integration: type to
 * the AI assistant of one Home Assistant Area. Your messages sit on the right,
 * the assistant's on the left, history survives reloads and restarts.
 *
 * The integration serves and registers this file automatically - no Lovelace
 * resource to add. Keep CARD_VERSION in lockstep with manifest.json and
 * const.py's CARD_VERSION on every release (it also cache-busts the file).
 */
(() => {
  "use strict";

  const CARD_VERSION = "2026.09.19.05";
  const CARD_TAG = "ha-local-area-concierge-card";
  const EDITOR_TAG = "ha-local-area-concierge-card-editor";
  const DOMAIN = "local_area_concierge";
  const REPO_URL = "https://github.com/drmogie/ha-local-area-concierge";

  const MAX_RECORD_MS = 12000; // hard stop for one voice message
  const STT_WAIT_MS = 10000; // how long to wait for speech-to-text after stopping
  const STT_RATE = 16000; // Assist pipelines take 16 kHz, 16-bit, mono
  const RETRY_MS = 3000;
  const CLEAR_ARM_MS = 3000;

  // Concrete mid-tone defaults that stay readable in light and dark themes.
  const DEFAULT_USER_COLOR = [3, 155, 229];
  const DEFAULT_AI_COLOR = [96, 125, 139];

  const DEFAULTS = {
    show_header: true,
    show_border: true,
    user_bubble_color: DEFAULT_USER_COLOR,
    user_bubble_transparent: false,
    ai_bubble_color: DEFAULT_AI_COLOR,
    ai_bubble_transparent: false,
    announce_default: false,
  };

  // ------------------------------------------------------------ small helpers

  const toRgb = (v) => {
    if (Array.isArray(v) && v.length >= 3) return [v[0], v[1], v[2]].map(Number);
    if (typeof v === "string") {
      const m = v.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (m) {
        let h = m[1];
        if (h.length === 3) h = h.split("").map((c) => c + c).join("");
        return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
      }
    }
    return null;
  };
  const cssColor = (v, fallback) => {
    const rgb = toRgb(v) || toRgb(fallback);
    return rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : String(fallback);
  };
  const contrastText = (v, fallback) => {
    const rgb = toRgb(v) || toRgb(fallback);
    if (!rgb) return "var(--primary-text-color)";
    const y = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    return y > 0.6 ? "#000000" : "#ffffff";
  };

  // ------------------------------------------------------------------- card

  class HaLocalAreaConciergeCard extends HTMLElement {
    static getConfigElement() {
      return document.createElement(EDITOR_TAG);
    }

    static async getStubConfig(hass) {
      // Pre-pick the first Concierge so a freshly added card works at once.
      try {
        const list = await Promise.race([
          hass.callWS({ type: `${DOMAIN}/list` }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
        ]);
        if (Array.isArray(list) && list.length) return { entry_id: list[0].entry_id };
      } catch (_e) {
        /* fall through to an empty stub */
      }
      return {};
    }

    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._config = null;
      this._hass = null;
      this._conn = null;

      this._meta = null;
      this._messages = [];
      this._status = "idle";
      this._offline = false;
      this._sending = false;
      this._announce = false;

      this._unsub = null; // ws unsubscribe handle (async, set after subscribe resolves)
      this._subKey = null; // synchronous "already subscribing/subscribed" marker
      this._subGen = 0;
      this._retryTimer = null;
      this._tickTimer = null;
      this._pollTimer = null;
      this._clearTimer = null;
      this._noteTimer = null;
      this._mic = null;
      this._built = false;
      this._connListeners = null;
    }

    // ---------------------------------------------------------- HA card API

    setConfig(config) {
      if (!config || typeof config !== "object") {
        throw new Error("Invalid configuration");
      }
      // Never throw for "nothing picked yet" - that freezes the card editor.
      const prev = this._config;
      this._config = { ...DEFAULTS, ...config };
      this._announce = !!(this._config.announce_entity && this._config.announce_default);
      this._build();
      this._applyConfig();
      if (!prev || prev.entry_id !== this._config.entry_id) {
        this._resetState();
        this._unsubscribe();
        this._subscribe();
      } else {
        this._renderAll();
      }
    }

    set hass(hass) {
      this._hass = hass;
      if (hass && hass.connection !== this._conn) {
        this._bindConnection(hass.connection);
        this._subscribe();
      }
    }

    get hass() {
      return this._hass;
    }

    getCardSize() {
      return 6;
    }

    getGridOptions() {
      return { columns: 12, rows: 6, min_columns: 4, min_rows: 4 };
    }

    connectedCallback() {
      this._build();
      this._startTimers();
      if (this._hass && this._hass.connection && !this._conn) this._bindConnection(this._hass.connection);
      this._subscribe();
    }

    disconnectedCallback() {
      this._unsubscribe();
      this._stopTimers();
      this._unbindConnection();
      if (this._mic) this._teardownMic(this._mic);
      clearTimeout(this._retryTimer);
      clearTimeout(this._clearTimer);
      clearTimeout(this._noteTimer);
    }

    // ---------------------------------------------------------------- build

    _build() {
      if (this._built) return;
      this._built = true;
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; height: 100%; }
          ha-card {
            height: 100%;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            position: relative;
            box-sizing: border-box;
          }
          [hidden] { display: none !important; }
          button { font: inherit; }
          .hdr {
            display: flex; align-items: center; gap: 10px;
            padding: 10px 12px 8px 16px;
            border-bottom: 1px solid var(--divider-color, rgba(127,127,127,.25));
            flex: 0 0 auto;
          }
          .dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto;
                 background: var(--disabled-text-color, #9e9e9e); }
          .dot.ok { background: var(--success-color, #43a047); }
          .dot.busy { background: var(--warning-color, #ffa000); animation: lac-pulse 1s ease-in-out infinite; }
          .dot.bad { background: var(--error-color, #db4437); }
          .hdr-text { flex: 1 1 auto; min-width: 0; }
          .title { font-size: 1.05em; font-weight: 500; color: var(--primary-text-color);
                   white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .sub { font-size: .78em; color: var(--secondary-text-color); }
          .hdr-actions { display: flex; align-items: center; flex: 0 0 auto; }
          .ib {
            border: none; background: transparent; cursor: pointer;
            color: var(--secondary-text-color);
            width: 36px; height: 36px; border-radius: 50%;
            display: inline-flex; align-items: center; justify-content: center;
            padding: 0; flex: 0 0 auto;
          }
          .ib:hover { background: var(--secondary-background-color, rgba(127,127,127,.15)); }
          .ib:disabled { opacity: .4; cursor: default; }
          .ib.on { color: var(--primary-color); }
          .ib.armed { color: var(--error-color, #db4437); }
          .ib.rec { color: #fff; background: var(--error-color, #db4437); animation: lac-pulse 1s ease-in-out infinite; }

          .msgs {
            flex: 1 1 0; min-height: 120px; overflow-y: auto;
            padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
          }
          .empty { margin: auto; text-align: center; color: var(--secondary-text-color);
                   font-size: .95em; padding: 12px; max-width: 32em; }
          .row { display: flex; }
          .row.user { justify-content: flex-end; }
          .row.ai { justify-content: flex-start; }
          .bubble {
            max-width: 82%; padding: 8px 12px; border-radius: 16px;
            border: var(--lac-bd-w, 1px) solid var(--lac-bd-color, var(--divider-color, rgba(127,127,127,.4)));
            box-sizing: border-box; overflow-wrap: anywhere;
          }
          .row.user .bubble { background: var(--lac-user-bg); color: var(--lac-user-fg); border-bottom-right-radius: 4px; }
          .row.ai .bubble { background: var(--lac-ai-bg); color: var(--lac-ai-fg); border-bottom-left-radius: 4px; }
          .row.err .bubble { border-color: var(--error-color, #db4437); border-width: 1px; border-style: solid; }
          .txt { white-space: pre-wrap; line-height: 1.35; }
          .ts { font-size: .7em; opacity: .75; margin-top: 3px; text-align: right; }
          .row.ai .ts { text-align: left; }
          .dots { display: inline-flex; gap: 4px; padding: 4px 2px; }
          .dots i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: .5;
                    animation: lac-bounce 1.2s infinite ease-in-out; }
          .dots i:nth-child(2) { animation-delay: .15s; }
          .dots i:nth-child(3) { animation-delay: .3s; }

          .inp {
            display: flex; align-items: flex-end; gap: 4px;
            padding: 8px 8px 10px 12px; flex: 0 0 auto;
            border-top: 1px solid var(--divider-color, rgba(127,127,127,.25));
          }
          textarea {
            flex: 1 1 auto; resize: none; box-sizing: border-box;
            font: inherit; line-height: 1.35; max-height: 7.5em;
            padding: 8px 12px; border-radius: 18px;
            border: 1px solid var(--divider-color, rgba(127,127,127,.4));
            background: var(--card-background-color, transparent);
            color: var(--primary-text-color); outline: none;
          }
          textarea:focus { border-color: var(--primary-color); }
          textarea:disabled { opacity: .6; }

          .note {
            position: absolute; left: 12px; right: 12px; bottom: 60px;
            padding: 6px 10px; border-radius: 8px; font-size: .85em; text-align: center;
            background: var(--secondary-background-color, #333); color: var(--primary-text-color);
            box-shadow: 0 1px 4px rgba(0,0,0,.3); z-index: 3;
          }
          .msg-card {
            margin: auto; text-align: center; color: var(--secondary-text-color); padding: 24px 16px;
          }

          .popup {
            position: absolute; inset: 0; z-index: 4; display: flex;
            align-items: flex-start; justify-content: flex-end;
            background: rgba(0,0,0,.25);
          }
          .popup-card {
            margin: 52px 10px 10px; padding: 12px; border-radius: 12px; max-width: min(92%, 360px);
            max-height: calc(100% - 64px); overflow-y: auto; box-sizing: border-box;
            background: var(--card-background-color, #fff);
            box-shadow: 0 4px 16px rgba(0,0,0,.35);
          }
          .popup-title { font-weight: 500; margin-bottom: 8px; color: var(--primary-text-color); }
          .chips { display: flex; flex-wrap: wrap; gap: 6px; }
          .chip {
            border: 1px solid var(--primary-color); color: var(--primary-color); background: transparent;
            border-radius: 16px; padding: 5px 12px; cursor: pointer; font-size: .9em;
          }
          .chip:hover { background: var(--primary-color); color: var(--text-primary-color, #fff); }
          .loading { color: var(--secondary-text-color); font-size: .9em; }

          @keyframes lac-pulse { 50% { opacity: .45; } }
          @keyframes lac-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .4; }
                                  30% { transform: translateY(-4px); opacity: 1; } }
        </style>
        <ha-card>
          <div class="hdr">
            <span class="dot"></span>
            <div class="hdr-text"><div class="title"></div><div class="sub"></div></div>
            <div class="hdr-actions">
              <button class="ib announce" type="button" hidden><ha-icon icon="mdi:volume-high"></ha-icon></button>
              <button class="ib sugg" type="button" title="Suggested prompts"><ha-icon icon="mdi:lightbulb-on-outline"></ha-icon></button>
              <button class="ib clear" type="button" title="New conversation (clears the chat)"><ha-icon icon="mdi:broom"></ha-icon></button>
            </div>
          </div>
          <div class="msgs"></div>
          <div class="inp">
            <textarea rows="1" placeholder="Type a message"></textarea>
            <button class="ib mic" type="button" hidden title="Speak"><ha-icon icon="mdi:microphone"></ha-icon></button>
            <button class="ib send on" type="button" title="Send"><ha-icon icon="mdi:send"></ha-icon></button>
          </div>
          <div class="note" hidden></div>
          <div class="popup" hidden>
            <div class="popup-card">
              <div class="popup-title">Suggested prompts</div>
              <div class="chips"></div>
            </div>
          </div>
        </ha-card>`;

      const $ = (s) => this.shadowRoot.querySelector(s);
      this._el = {
        card: $("ha-card"),
        hdr: $(".hdr"),
        dot: $(".dot"),
        title: $(".title"),
        sub: $(".sub"),
        announce: $(".announce"),
        sugg: $(".sugg"),
        clear: $(".clear"),
        msgs: $(".msgs"),
        input: $("textarea"),
        mic: $(".mic"),
        send: $(".send"),
        note: $(".note"),
        popup: $(".popup"),
        chips: $(".chips"),
      };

      const e = this._el;
      e.send.addEventListener("click", () => this._send(e.input.value));
      e.input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
          ev.preventDefault();
          this._send(e.input.value);
        }
      });
      e.input.addEventListener("input", () => this._autoGrow());
      e.announce.addEventListener("click", () => {
        this._announce = !this._announce;
        this._renderAnnounce();
      });
      e.sugg.addEventListener("click", () => this._openSuggestions());
      e.popup.addEventListener("click", (ev) => {
        if (ev.target === e.popup) this._closeSuggestions();
      });
      e.clear.addEventListener("click", () => this._onClearClick());
      e.mic.addEventListener("click", () => this._toggleMic());
      this.shadowRoot.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") this._closeSuggestions();
      });
    }

    // ------------------------------------------------------ config -> view

    _applyConfig() {
      if (!this._el) return;
      const c = this._config;
      const e = this._el;
      e.hdr.hidden = c.show_header === false;

      const userTransparent = !!c.user_bubble_transparent;
      const aiTransparent = !!c.ai_bubble_transparent;
      const s = e.card.style;
      s.setProperty("--lac-user-bg", userTransparent ? "transparent" : cssColor(c.user_bubble_color, DEFAULT_USER_COLOR));
      s.setProperty("--lac-user-fg", userTransparent ? "var(--primary-text-color)" : contrastText(c.user_bubble_color, DEFAULT_USER_COLOR));
      s.setProperty("--lac-ai-bg", aiTransparent ? "transparent" : cssColor(c.ai_bubble_color, DEFAULT_AI_COLOR));
      s.setProperty("--lac-ai-fg", aiTransparent ? "var(--primary-text-color)" : contrastText(c.ai_bubble_color, DEFAULT_AI_COLOR));
      s.setProperty("--lac-bd-w", c.show_border === false ? "0px" : "1px");
      const h = Number(c.card_height);
      s.height = h > 0 ? `${h}px` : "";

      this._renderHeader();
      this._renderAnnounce();
      this._renderMic();
    }

    _areaName() {
      return (this._meta && this._meta.area_name) || "this area";
    }

    _renderHeader() {
      if (!this._el) return;
      const c = this._config || {};
      const meta = this._meta;
      const title = (c.title || "").trim() || (meta && meta.title) || "Local Area Concierge";
      this._el.title.textContent = title;

      let cls = "";
      let label = "Connecting…";
      if (!c.entry_id) {
        label = "Not set up";
      } else if (this._offline) {
        label = "Offline";
      } else if (meta) {
        if (!meta.available) {
          cls = "bad";
          label = "Assistant unavailable";
        } else if (this._status === "thinking") {
          cls = "busy";
          label = "Thinking…";
        } else if (this._status === "error") {
          cls = "bad";
          label = "Last request failed";
        } else {
          cls = "ok";
          label = meta.pipeline_name ? `Ready · ${meta.pipeline_name}` : "Ready";
        }
      }
      this._el.dot.className = `dot ${cls}`;
      this._el.sub.textContent = label;
      this._el.hdr.title = meta && meta.pipeline_name ? `Assist Pipeline: ${meta.pipeline_name}` : "";
      this._el.input.placeholder = meta ? `Message ${meta.area_name}` : "Type a message";
      this._syncControls();
    }

    _syncControls() {
      if (!this._el) return;
      const ready = !!(this._config && this._config.entry_id && this._meta);
      const busy = this._sending || this._status === "thinking";
      this._el.send.disabled = !ready || busy;
      this._el.input.disabled = !ready;
      this._el.sugg.disabled = !ready;
      this._el.clear.disabled = !ready || busy;
    }

    _renderAnnounce() {
      if (!this._el) return;
      const has = !!(this._config && this._config.announce_entity);
      const b = this._el.announce;
      b.hidden = !has;
      if (!has) return;
      b.classList.toggle("on", this._announce);
      b.querySelector("ha-icon").setAttribute("icon", this._announce ? "mdi:volume-high" : "mdi:volume-off");
      b.title = this._announce
        ? "Replies are spoken aloud - tap to turn off (until you refresh the page)"
        : "Replies are silent - tap to speak them aloud (until you refresh the page)";
    }

    _micAvailable() {
      return !!(
        this._meta &&
        this._meta.has_stt &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === "function" &&
        window.isSecureContext !== false
      );
    }

    _renderMic() {
      if (!this._el) return;
      const b = this._el.mic;
      b.hidden = !this._micAvailable();
      const icon = b.querySelector("ha-icon");
      b.classList.remove("rec");
      b.disabled = false;
      if (!this._mic) {
        icon.setAttribute("icon", "mdi:microphone");
        b.title = "Speak";
      } else if (!this._mic.captureStopped) {
        icon.setAttribute("icon", "mdi:stop");
        b.classList.add("rec");
        b.title = "Stop listening";
      } else {
        icon.setAttribute("icon", "mdi:dots-horizontal");
        b.disabled = true;
        b.title = "Working out what you said…";
      }
    }

    // -------------------------------------------------------- state / timers

    _resetState() {
      this._meta = null;
      this._messages = [];
      this._status = "idle";
      this._offline = false;
      this._sending = false;
      this._renderHeader();
      this._renderAll();
    }

    _startTimers() {
      this._stopTimers();
      this._tickTimer = setInterval(() => this._refreshTimes(), 30000);
      this._pollTimer = setInterval(() => this._pollStatus(), 60000);
    }

    _stopTimers() {
      clearInterval(this._tickTimer);
      clearInterval(this._pollTimer);
      this._tickTimer = this._pollTimer = null;
    }

    async _pollStatus() {
      const c = this._config;
      if (!this._hass || !c || !c.entry_id || this._offline) return;
      try {
        const meta = await this._hass.callWS({ type: `${DOMAIN}/status`, entry_id: c.entry_id });
        if (this._config && this._config.entry_id === c.entry_id) {
          this._meta = meta;
          this._renderHeader();
          this._renderMic();
        }
      } catch (_e) {
        /* the subscription's own retry handles a missing concierge */
      }
    }

    // ----------------------------------------------------------- connection

    _bindConnection(conn) {
      this._unbindConnection();
      this._conn = conn;
      if (!conn || typeof conn.addEventListener !== "function") return;
      const down = () => {
        this._offline = true;
        this._renderHeader();
      };
      const up = () => {
        this._offline = false;
        this._renderHeader();
      };
      conn.addEventListener("disconnected", down);
      conn.addEventListener("ready", up);
      this._connListeners = { conn, down, up };
    }

    _unbindConnection() {
      const l = this._connListeners;
      if (l && l.conn && typeof l.conn.removeEventListener === "function") {
        l.conn.removeEventListener("disconnected", l.down);
        l.conn.removeEventListener("ready", l.up);
      }
      this._connListeners = null;
      this._conn = null;
    }

    // --------------------------------------------------------- subscription

    _unsubscribe() {
      // Synchronous on purpose: bump the generation and clear the marker
      // first, so an in-flight subscribe() that resolves later notices it is
      // stale and cleans itself up, instead of double-subscribing.
      this._subGen += 1;
      this._subKey = null;
      clearTimeout(this._retryTimer);
      const unsub = this._unsub;
      this._unsub = null;
      if (unsub) {
        try {
          unsub();
        } catch (_e) {
          /* connection already gone */
        }
      }
    }

    async _subscribe() {
      const c = this._config;
      if (!this._hass || !this._hass.connection || !c || !c.entry_id || !this.isConnected) return;
      const key = c.entry_id;
      if (this._subKey === key) return; // already subscribing/subscribed
      this._unsubscribe();
      this._subKey = key;
      const gen = this._subGen;
      try {
        const unsub = await this._hass.connection.subscribeMessage((ev) => this._onEvent(ev, gen), {
          type: `${DOMAIN}/subscribe`,
          entry_id: key,
        });
        if (gen !== this._subGen) {
          unsub(); // superseded while we were waiting
          return;
        }
        this._unsub = unsub;
      } catch (err) {
        if (gen !== this._subGen) return;
        this._subKey = null;
        this._meta = null;
        this._renderMissing(err);
        this._retryTimer = setTimeout(() => this._subscribe(), RETRY_MS * 3);
      }
    }

    _renderMissing(err) {
      const code = err && err.code;
      const text =
        code === "not_found"
          ? "This Concierge isn't set up (or was removed). Pick another one in the card editor."
          : "Can't reach the Concierge right now. Retrying…";
      this._renderHeader();
      if (this._el) {
        this._el.msgs.replaceChildren();
        const d = document.createElement("div");
        d.className = "msg-card";
        d.textContent = text;
        this._el.msgs.appendChild(d);
      }
    }

    _onEvent(ev, gen) {
      if (gen !== this._subGen || !ev) return;
      this._offline = false;
      switch (ev.type) {
        case "snapshot":
          this._meta = ev.meta;
          this._messages = Array.isArray(ev.messages) ? ev.messages.slice() : [];
          this._status = ev.status || "idle";
          this._renderHeader();
          this._renderMic();
          this._renderAll();
          break;
        case "message":
          if (ev.message && !this._messages.some((m) => m.id === ev.message.id)) {
            this._messages.push(ev.message);
            const limit = (this._meta && this._meta.max_messages) || 500;
            if (this._messages.length > limit) this._messages.splice(0, this._messages.length - limit);
            this._appendBubble(ev.message);
          }
          break;
        case "status":
          this._status = ev.status;
          if (this._meta && typeof ev.available === "boolean") this._meta.available = ev.available;
          this._renderHeader();
          this._syncTyping();
          break;
        case "cleared":
          this._messages = [];
          this._renderAll();
          break;
        case "closed":
          // The concierge was reloaded (options changed) or removed: re-attach.
          this._unsubscribe();
          this._retryTimer = setTimeout(() => this._subscribe(), 1500);
          break;
        default:
          break;
      }
    }

    // ------------------------------------------------------------ rendering

    _fmtTime(iso) {
      const d = new Date(iso);
      if (isNaN(d)) return "";
      const diff = (Date.now() - d.getTime()) / 1000;
      if (diff < 45) return "just now";
      if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} min ago`;
      const lang = (this._hass && this._hass.locale && this._hass.locale.language) || undefined;
      return d.toLocaleString(lang, { dateStyle: "medium", timeStyle: "short" });
    }

    _refreshTimes() {
      if (!this._el) return;
      this._el.msgs.querySelectorAll(".ts[data-ts]").forEach((n) => {
        n.textContent = this._fmtTime(n.dataset.ts);
      });
    }

    _makeBubble(m) {
      const row = document.createElement("div");
      row.className = `row ${m.role === "user" ? "user" : "ai"}${m.role === "error" ? " err" : ""}`;
      row.dataset.id = m.id;
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      const txt = document.createElement("div");
      txt.className = "txt";
      txt.textContent = m.text; // textContent: replies are never treated as HTML
      const ts = document.createElement("div");
      ts.className = "ts";
      ts.dataset.ts = m.ts;
      ts.textContent = this._fmtTime(m.ts);
      bubble.append(txt, ts);
      row.appendChild(bubble);
      return row;
    }

    _renderAll() {
      if (!this._el) return;
      const box = this._el.msgs;
      box.replaceChildren();
      if (!this._config || !this._config.entry_id) {
        const d = document.createElement("div");
        d.className = "msg-card";
        d.textContent = "Pick a Concierge in the card editor to start chatting.";
        box.appendChild(d);
        return;
      }
      if (!this._meta) return;
      if (!this._messages.length && this._status !== "thinking") {
        const d = document.createElement("div");
        d.className = "empty";
        d.textContent = `Ask me to do something in ${this._areaName()}, or tap the lightbulb for ideas.`;
        d.dataset.empty = "1";
        box.appendChild(d);
      }
      for (const m of this._messages) box.appendChild(this._makeBubble(m));
      this._syncTyping();
      this._scrollBottom(true);
    }

    _appendBubble(m) {
      const box = this._el.msgs;
      const stick = this._nearBottom() || m.role === "user";
      box.querySelector("[data-empty]")?.remove();
      const typing = box.querySelector(".typing");
      const node = this._makeBubble(m);
      if (typing) box.insertBefore(node, typing);
      else box.appendChild(node);
      this._syncTyping();
      if (stick) this._scrollBottom(true);
    }

    _syncTyping() {
      if (!this._el) return;
      const box = this._el.msgs;
      const existing = box.querySelector(".typing");
      const want = this._status === "thinking" && !!this._meta;
      if (want && !existing) {
        box.querySelector("[data-empty]")?.remove();
        const row = document.createElement("div");
        row.className = "row ai typing";
        const bubble = document.createElement("div");
        bubble.className = "bubble";
        bubble.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
        row.appendChild(bubble);
        box.appendChild(row);
        this._scrollBottom(true);
      } else if (!want && existing) {
        existing.remove();
      }
      this._syncControls();
    }

    _nearBottom() {
      const b = this._el.msgs;
      return b.scrollHeight - b.scrollTop - b.clientHeight < 80;
    }

    _scrollBottom() {
      const b = this._el.msgs;
      requestAnimationFrame(() => {
        b.scrollTop = b.scrollHeight;
      });
    }

    _autoGrow() {
      const t = this._el.input;
      t.style.height = "auto";
      t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
    }

    _note(text) {
      const n = this._el.note;
      n.textContent = text;
      n.hidden = false;
      clearTimeout(this._noteTimer);
      this._noteTimer = setTimeout(() => {
        n.hidden = true;
      }, 4000);
    }

    // --------------------------------------------------------------- actions

    async _send(text) {
      const c = this._config;
      text = (text || "").trim();
      if (!text || !this._hass || !c || !c.entry_id || !this._meta) return;
      if (this._sending || this._status === "thinking") return;
      this._sending = true;
      this._el.input.value = "";
      this._autoGrow();
      this._syncControls();
      const payload = { type: `${DOMAIN}/send`, entry_id: c.entry_id, text };
      if (c.announce_entity && this._announce) payload.announce_entity = c.announce_entity;
      try {
        // The reply arrives through the subscription like every other message.
        await this._hass.callWS(payload);
      } catch (_err) {
        // The backend couldn't be reached at all. Show a bubble that is local
        // to this browser (the backend stores its own errors).
        const m = {
          id: `local-${Date.now()}`,
          role: "error",
          text: "Couldn't reach the assistant",
          ts: new Date().toISOString(),
        };
        this._messages.push(m);
        this._appendBubble(m);
      } finally {
        this._sending = false;
        this._syncControls();
        if (this._el) this._el.input.focus();
      }
    }

    _onClearClick() {
      const c = this._config;
      if (!c || !c.entry_id || !this._hass) return;
      const b = this._el.clear;
      if (!b.classList.contains("armed")) {
        // Two taps on purpose: the first arms it, the second wipes the chat.
        b.classList.add("armed");
        b.title = "Tap again to clear the chat";
        b.querySelector("ha-icon").setAttribute("icon", "mdi:check");
        this._clearTimer = setTimeout(() => this._disarmClear(), CLEAR_ARM_MS);
        return;
      }
      this._disarmClear();
      if (this._el.input) {
        this._el.input.value = "";
        this._autoGrow();
      }
      this._hass.callWS({ type: `${DOMAIN}/clear`, entry_id: c.entry_id }).catch(() => {
        this._note("Couldn't clear the chat");
      });
    }

    _disarmClear() {
      clearTimeout(this._clearTimer);
      const b = this._el && this._el.clear;
      if (!b) return;
      b.classList.remove("armed");
      b.title = "New conversation (clears the chat)";
      b.querySelector("ha-icon").setAttribute("icon", "mdi:broom");
    }

    async _openSuggestions() {
      const c = this._config;
      if (!c || !c.entry_id || !this._hass) return;
      const chips = this._el.chips;
      chips.replaceChildren();
      const loading = document.createElement("span");
      loading.className = "loading";
      loading.textContent = "Loading…";
      chips.appendChild(loading);
      this._el.popup.hidden = false;
      try {
        const list = await this._hass.callWS({ type: `${DOMAIN}/suggestions`, entry_id: c.entry_id });
        chips.replaceChildren();
        for (const text of list) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "chip";
          b.textContent = text;
          b.addEventListener("click", () => {
            this._closeSuggestions();
            this._send(text);
          });
          chips.appendChild(b);
        }
      } catch (_e) {
        loading.textContent = "Couldn't load suggestions";
      }
    }

    _closeSuggestions() {
      if (this._el) this._el.popup.hidden = true;
    }

    // ------------------------------------------------------------------ mic
    //
    // Voice input runs the Assist Pipeline's own speech-to-text (stage "stt"
    // only): audio is streamed as 16 kHz mono PCM over the websocket, the
    // recognised text then goes through the normal send path.

    _toPcm16(input, inRate) {
      let data = input;
      if (inRate !== STT_RATE) {
        const ratio = inRate / STT_RATE;
        const outLen = Math.floor(input.length / ratio);
        data = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const start = Math.floor(i * ratio);
          const end = Math.min(Math.floor((i + 1) * ratio), input.length);
          let sum = 0;
          let n = 0;
          for (let j = start; j < end; j++) {
            sum += input[j];
            n++;
          }
          data[i] = n ? sum / n : 0;
        }
      }
      const out = new Int16Array(data.length);
      for (let i = 0; i < data.length; i++) {
        const s = Math.max(-1, Math.min(1, data[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    }

    _sendPcm(mic, pcm) {
      const socket = this._hass && this._hass.connection && this._hass.connection.socket;
      if (!socket || socket.readyState !== 1) return;
      const packet = new Uint8Array(1 + pcm.byteLength);
      packet[0] = mic.handlerId;
      packet.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1);
      socket.send(packet);
    }

    _sendEnd(mic) {
      const socket = this._hass && this._hass.connection && this._hass.connection.socket;
      if (socket && socket.readyState === 1) socket.send(new Uint8Array([mic.handlerId]));
    }

    async _toggleMic() {
      if (this._mic) {
        if (!this._mic.captureStopped) this._stopCapture(this._mic);
        return;
      }
      if (!this._hass || !this._meta || !this._micAvailable()) return;
      if (this._sending || this._status === "thinking") return;

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
      } catch (_e) {
        this._note("Microphone blocked or unavailable");
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mic = {
        stream, ctx, src, proc,
        handlerId: null, queue: [], unsub: null, timer: null,
        captureStopped: false, endPending: false, released: false, finished: false,
      };
      this._mic = mic;

      proc.onaudioprocess = (ev) => {
        if (mic.captureStopped) return;
        const pcm = this._toPcm16(ev.inputBuffer.getChannelData(0), ctx.sampleRate);
        if (mic.handlerId == null) {
          mic.queue.push(pcm); // hold audio until the pipeline says where to send it
          if (mic.queue.length > 80) mic.queue.shift();
        } else {
          this._sendPcm(mic, pcm);
        }
      };
      src.connect(proc);
      proc.connect(ctx.destination); // required for the callback to fire; output stays silent
      mic.timer = setTimeout(() => this._stopCapture(mic), MAX_RECORD_MS);
      this._renderMic();

      try {
        mic.unsub = await this._hass.connection.subscribeMessage((ev) => this._onSttEvent(mic, ev), {
          type: "assist_pipeline/run",
          start_stage: "stt",
          end_stage: "stt",
          input: { sample_rate: STT_RATE },
          pipeline: this._meta.pipeline_id,
        });
        if (mic.finished && mic.unsub) mic.unsub();
      } catch (_e) {
        this._teardownMic(mic, "Speech recognition isn't available");
      }
    }

    _onSttEvent(mic, ev) {
      if (mic.finished || !ev) return;
      const d = ev.data || {};
      switch (ev.type) {
        case "run-start": {
          const id = d.runner_data && d.runner_data.stt_binary_handler_id;
          if (id == null) {
            this._teardownMic(mic, "Speech recognition isn't available");
            return;
          }
          mic.handlerId = id;
          for (const pcm of mic.queue) this._sendPcm(mic, pcm);
          mic.queue = [];
          if (mic.endPending) this._sendEnd(mic);
          break;
        }
        case "stt-vad-end":
          this._stopCapture(mic); // the pipeline heard you finish speaking
          break;
        case "stt-end": {
          const text = ((d.stt_output && d.stt_output.text) || "").trim();
          this._teardownMic(mic, text ? null : "Didn't catch that");
          if (text) this._send(text);
          break;
        }
        case "error":
          this._teardownMic(mic, d.message || "Speech recognition failed");
          break;
        case "run-end":
          this._teardownMic(mic);
          break;
        default:
          break;
      }
    }

    _releaseAudio(mic) {
      if (mic.released) return;
      mic.released = true;
      mic.captureStopped = true;
      try {
        mic.proc.onaudioprocess = null;
        mic.proc.disconnect();
        mic.src.disconnect();
      } catch (_e) {
        /* already disconnected */
      }
      mic.stream.getTracks().forEach((t) => t.stop());
      try {
        mic.ctx.close();
      } catch (_e) {
        /* already closed */
      }
    }

    _stopCapture(mic) {
      if (mic.finished || mic.captureStopped) return;
      clearTimeout(mic.timer);
      this._releaseAudio(mic);
      if (mic.handlerId != null) this._sendEnd(mic);
      else mic.endPending = true;
      mic.timer = setTimeout(() => this._teardownMic(mic, "Speech recognition timed out"), STT_WAIT_MS);
      this._renderMic();
    }

    _teardownMic(mic, note) {
      if (mic.finished) return;
      mic.finished = true;
      clearTimeout(mic.timer);
      this._releaseAudio(mic);
      if (mic.unsub) {
        try {
          mic.unsub();
        } catch (_e) {
          /* connection already gone */
        }
      }
      if (this._mic === mic) this._mic = null;
      if (note && this._el) this._note(note);
      this._renderMic();
    }
  }

  // ----------------------------------------------------------------- editor

  class HaLocalAreaConciergeCardEditor extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._config = {};
      this._hass = null;
      this._devices = null; // null = not loaded yet
      this._form = null;
    }

    setConfig(config) {
      this._config = { ...(config || {}) };
      this._render();
    }

    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      if (this._form) this._form.hass = hass;
      if (first && hass) this._loadDevices();
    }

    async _loadDevices() {
      try {
        this._devices = await this._hass.callWS({ type: `${DOMAIN}/list` });
      } catch (_e) {
        this._devices = [];
      }
      this._render();
    }

    _schema() {
      const c = this._config;
      const devices = this._devices || [];
      const options = devices.map((d) => ({ value: d.entry_id, label: `${d.title} (${d.area_name})` }));
      // Keep a saved-but-missing choice visible instead of silently dropping it.
      if (c.entry_id && !options.some((o) => o.value === c.entry_id)) {
        options.push({ value: c.entry_id, label: "(unavailable Concierge)" });
      }
      const schema = [
        { name: "entry_id", required: true, selector: { select: { options, mode: "dropdown" } } },
        { name: "title", selector: { text: {} } },
        { name: "show_header", selector: { boolean: {} } },
        {
          type: "expandable",
          name: "",
          title: "Bubble colors",
          schema: [
            { name: "user_bubble_color", selector: { color_rgb: {} } },
            { name: "user_bubble_transparent", selector: { boolean: {} } },
            { name: "ai_bubble_color", selector: { color_rgb: {} } },
            { name: "ai_bubble_transparent", selector: { boolean: {} } },
            { name: "show_border", selector: { boolean: {} } },
          ],
        },
        {
          type: "expandable",
          name: "",
          title: "Spoken replies",
          schema: [
            { name: "announce_entity", selector: { entity: { domain: "media_player" } } },
            // Only relevant once a media player is picked.
            ...(c.announce_entity ? [{ name: "announce_default", selector: { boolean: {} } }] : []),
          ],
        },
        {
          type: "expandable",
          name: "",
          title: "Size",
          schema: [
            { name: "card_height", selector: { number: { min: 0, max: 2000, step: 10, mode: "box", unit_of_measurement: "px" } } },
          ],
        },
      ];
      return schema;
    }

    _labels() {
      return {
        entry_id: "Concierge (Area)",
        title: "Title (optional)",
        show_header: "Show header (title, status and buttons)",
        user_bubble_color: "Your bubble color",
        user_bubble_transparent: "Your bubble: transparent background",
        ai_bubble_color: "Assistant bubble color",
        ai_bubble_transparent: "Assistant bubble: transparent background",
        show_border: "Show bubble borders",
        announce_entity: "Speak replies on this media player",
        announce_default: "Announce AI replies (default)",
        card_height: "Fixed card height (0 or blank = fill the space the layout gives it)",
      };
    }

    _helpers() {
      return {
        entry_id: this._devices && !this._devices.length
          ? "No Concierge found. Add one under Settings → Devices & services → Add integration → Local Area Concierge."
          : "Which Area's assistant this card talks to.",
        announce_entity: "Optional. Replies are spoken using the TTS voice of that Area's Assist Pipeline.",
        announce_default: "Off by default. The speaker button on the card can flip it temporarily; a page refresh returns to this setting.",
      };
    }

    _render() {
      if (!this._form) {
        this.shadowRoot.innerHTML = `
          <style>
            .foot { text-align: center; font-size: .7em; opacity: .5; margin-top: 12px; color: var(--secondary-text-color); }
          </style>
          <div class="wrap"></div>
          <div class="foot">v${CARD_VERSION}</div>`;
        this._form = document.createElement("ha-form");
        this._form.computeLabel = (s) => this._labels()[s.name] || s.name;
        this._form.computeHelper = (s) => this._helpers()[s.name] || "";
        this._form.addEventListener("value-changed", (ev) => this._changed(ev));
        this.shadowRoot.querySelector(".wrap").appendChild(this._form);
      }
      this._form.hass = this._hass;
      this._form.data = { ...DEFAULTS, ...this._config };
      this._form.schema = this._schema();
    }

    _changed(ev) {
      ev.stopPropagation();
      const value = { ...(ev.detail && ev.detail.value) };
      // Drop empty values so the saved config stays clean.
      for (const k of Object.keys(value)) {
        if (value[k] === "" || value[k] === undefined || value[k] === null) delete value[k];
      }
      if (!value.announce_entity) delete value.announce_default;
      if (!(Number(value.card_height) > 0)) delete value.card_height;
      value.type = `custom:${CARD_TAG}`;
      this._config = value;
      this.dispatchEvent(
        new CustomEvent("config-changed", { detail: { config: value }, bubbles: true, composed: true })
      );
      this._render();
    }
  }

  // ------------------------------------------------------------ registration

  if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, HaLocalAreaConciergeCard);
  if (!customElements.get(EDITOR_TAG)) customElements.define(EDITOR_TAG, HaLocalAreaConciergeCardEditor);

  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === CARD_TAG)) {
    window.customCards.push({
      type: CARD_TAG,
      name: "Local Area Concierge Card",
      description: "Chat with the AI assistant of one Home Assistant Area (Local Area Concierge).",
      preview: false,
      documentationURL: REPO_URL,
    });
  }

  console.info(
    `%c LOCAL-AREA-CONCIERGE %c v${CARD_VERSION} `,
    "color:#fff;background:#039be5;font-weight:700;border-radius:3px 0 0 3px;padding:1px 2px",
    "color:#039be5;background:#fff;font-weight:700;border-radius:0 3px 3px 0;padding:1px 2px;border:1px solid #039be5"
  );
})();
