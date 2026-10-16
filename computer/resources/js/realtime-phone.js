/**
 * SynthOrg - the phone, in the general settings.
 *
 * The page "Phone" of the settings (section Telefono): the bridge turned on and off
 * with its two switches (the connection, for while the app is open, and the
 * service, for when it is closed), the start with the computer, which is a
 * switch of its own that nothing else moves, the router it goes through (the one the app starts, or one already
 * running), the phones paired and the pairing of a new one.
 *
 * Pairing shows a code once, as a QR code drawn in the page (qr.js), for as
 * long as the service says it is good. It is a secret: it is not kept, not
 * copied anywhere, and is gone when it is used, when it expires or when the
 * window is closed.
 *
 * These are methods of the assistant's object (realtime.js), kept in a file
 * of their own, drawn in #settings-subview-phone (main.js shows it). What
 * the phones ask is done in bridge.js.
 */
(function () {
  'use strict';

  const rt = window.realtime._state;
  const { t, esc } = window.realtime._util;
  const bridge = () => window.phoneBridge;
  const BANDWIDTHS = ['L', 'O', 'P', 'X'];

  Object.assign(rt, {
    phoneNote: '',
    phoneCopied: '',      // said beside the button that copies the pairing code
    phoneBusy: '',        // what is being done: 'switch', 'service', 'pairing', 'router', 'device', 'forget'
    phoneRenaming: null,
    phoneForgetAsked: false,
    phoneClock: null,
    phoneUnwatch: null,   // stops following the state of the bridge
    phoneTicks: 0,
    phoneDraft: null,     // which router and whether it carries transit, as picked and not saved yet

    phoneStatus() { return bridge()?.status || null; },

    /** Where the page is drawn, and whether it is on screen. */
    phoneHost() { return document.getElementById('settings-subview-phone'); },
    phoneOpen() {
      const host = this.phoneHost();
      return Boolean(host && host.style.display !== 'none' && host.offsetParent !== null);
    },

    /** The page shown: drawn, and followed while it stays on screen. */
    phoneShow() {
      const host = this.phoneHost();
      if (!host) return;
      if (!host.dataset.bound) {
        host.dataset.bound = '1';
        for (const type of ['click', 'change', 'submit']) host.addEventListener(type, (e) => this.onPhoneSettings(e));
      }
      this.phoneRenderPage(true);
    },

    /** Drawn again when what it shows changes; not while a field of it is being typed in, unless `force`. */
    phoneRenderPage(force = false) {
      const host = this.phoneHost();
      if (!host || (!force && !this.phoneOpen())) return;
      if (!force && host.contains(document.activeElement) && document.activeElement.matches('textarea, input[type="text"], input[type="password"], input[type="number"]')) return;
      const scroll = host.scrollTop;
      host.innerHTML = `<div class="phone-settings">${this.phonePage()}</div>`;
      host.scrollTop = scroll;
    },

    /** What the bridge is doing, in words. */
    phonePhaseText(status) {
      const { enabled, service } = status.settings || {};
      if (status.phase === 'off') return t(!enabled && service ? 'realtime.phonePhaseAtClose' : 'realtime.phonePhaseOff');
      if (status.phase === 'router') return t('realtime.phonePhaseRouter');
      if (status.phase === 'tunnels') return t('realtime.phonePhaseTunnels');
      if (status.phase === 'error') return t('realtime.phonePhaseError', { error: status.error || '' });
      if (status.phase === 'ready') {
        const connected = status.devices.filter(device => device.connected).length;
        if (!status.devices.length) return t('realtime.phonePhaseReadyNone');
        if (connected) return t(connected === 1 ? 'realtime.phonePhaseConnectedOne' : 'realtime.phonePhaseConnected', { count: connected });
        return t('realtime.phonePhaseReady');
      }
      return t('realtime.phonePhaseOff');
    },

    phoneWhen(stamp) {
      const date = new Date(stamp);
      if (!stamp || isNaN(date)) return '';
      return date.toLocaleString(window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    },

    phoneSecondsLeft(status) {
      const end = new Date(status?.pairing?.expiresAt || 0).getTime();
      return Math.max(0, Math.ceil((end - Date.now()) / 1000));
    },

    phonePage() {
      const status = this.phoneStatus();
      this.phoneWatch();
      if (!status) {
        return `<section class="rt-set-block"><h3>${esc(t('realtime.phoneTitle'))}</h3><p class="rt-hint">${esc(t('realtime.phoneLoading'))}</p></section>`;
      }
      if (status.locked) {
        return `<section class="rt-set-block"><h3>${esc(t('realtime.phoneTitle'))}</h3><p class="rt-hint">${esc(t('realtime.phoneLocked'))}</p></section>`;
      }
      // What was picked in the form stays as picked while the state of the bridge goes on changing under it.
      const settings = { ...status.settings, ...(this.phoneDraft || {}) };
      const on = status.settings.enabled;
      const service = status.settings.service;
      // What the system holds, not what the app remembers.
      const shell = bridge().shell;
      const autostart = shell?.autostart || 'off';
      const external = settings.mode === 'external' || !status.embeddedAvailable;
      const busy = Boolean(this.phoneBusy);
      const off = busy ? 'disabled' : '';

      const head = `
        <section class="rt-set-block">
          <h3>${esc(t('realtime.phoneTitle'))}</h3>
          <p class="rt-hint">${esc(t('realtime.phoneHint', { name: this.displayName() }))}</p>
          ${this.phoneNote ? `<p class="rt-hint" role="status">${esc(this.phoneNote)}</p>` : ''}
          <div class="rt-switch-row">
            <label class="synth-toggle-wrapper"><span class="synth-switch"><input type="checkbox" class="rt-phone-on" ${on ? 'checked' : ''} ${off}><span class="synth-slider"></span></span>
              <span><strong>${esc(t('realtime.phoneOn'))}</strong><small>${esc(t('realtime.phoneOnHint'))}</small></span></label>
          </div>
          <div class="rt-switch-row">
            <label class="synth-toggle-wrapper"><span class="synth-switch"><input type="checkbox" class="rt-phone-service" ${service ? 'checked' : ''} ${off}><span class="synth-slider"></span></span>
              <span><strong>${esc(t('realtime.phoneService'))}</strong><small>${esc(t('realtime.phoneServiceHint'))}</small></span></label>
          </div>
          <div class="rt-switch-row">
            <label class="synth-toggle-wrapper"><span class="synth-switch"><input type="checkbox" class="rt-phone-lan" ${status.settings.lan ? 'checked' : ''} ${off}><span class="synth-slider"></span></span>
              <span><strong>${esc(t('realtime.phoneLan'))}</strong><small>${esc(t('realtime.phoneLanHint'))}</small>
                ${status.settings.lan ? `<small class="rt-phone-entry">${esc(status.lan?.addresses?.length ? t('realtime.phoneLanListening', { where: status.lan.addresses.map(a => `${a.host}:${a.port}`).join(', ') }) : t('realtime.phoneLanWaiting'))}</small>` : ''}</span></label>
          </div>
          <div class="rt-switch-row">
            <label class="synth-toggle-wrapper"><span><strong>${esc(t('realtime.phoneHops'))}</strong><small>${esc(t('realtime.phoneHopsHint'))}</small>
              <select class="rt-phone-hops select-control" ${off}>${[1, 2, 3].map(n => `<option value="${n}" ${Number(status.settings.hops) === n ? 'selected' : ''}>${esc(t('realtime.phoneHops' + n))}</option>`).join('')}</select></span></label>
          </div>
          <div class="rt-switch-row">
            <label class="synth-toggle-wrapper"><span class="synth-switch"><input type="checkbox" class="rt-phone-autostart" ${autostart !== 'off' ? 'checked' : ''} ${shell ? off : 'disabled'}><span class="synth-slider"></span></span>
              <span><strong>${esc(t('realtime.phoneAutostart'))}</strong><small>${esc(t(shell ? 'realtime.phoneAutostartHint' : 'realtime.phoneAutostartUnavailable'))}</small>
                ${autostart !== 'off' && shell.entry ? `<small class="rt-phone-entry">${esc(t('realtime.phoneAutostartEntry', { entry: shell.entry }))}</small>` : ''}
                ${autostart === 'blocked' ? `<small class="rt-phone-blocked">${esc(t('realtime.phoneAutostartBlocked'))}</small>` : ''}</span></label>
          </div>
          <p class="rt-phone-phase is-${esc(status.phase)}" role="status"><i class="fa-solid ${status.phase === 'error' ? 'fa-triangle-exclamation' : status.phase === 'ready' ? 'fa-circle-check' : status.phase === 'off' ? 'fa-circle' : 'fa-spinner fa-spin'}"></i> ${esc(busy && this.phoneBusy === 'switch' ? t('realtime.phonePhaseRouter') : this.phonePhaseText(status))}</p>
          ${status.phase === 'error' ? `<button type="button" class="btn" data-action="phone-retry" ${off}>${esc(t('realtime.phoneRetry'))}</button>` : ''}
        </section>`;

      const router = `
        <section class="rt-set-block">
          <h3>${esc(t('realtime.phoneRouterTitle'))}</h3>
          <form class="rt-phone-router">
            <label class="rt-field">${esc(t('realtime.phoneRouterMode'))}
              <select class="rt-phone-mode select-control" ${off}>
                <option value="embedded" ${!external ? 'selected' : ''} ${status.embeddedAvailable ? '' : 'disabled'}>${esc(t('realtime.phoneModeEmbedded'))}</option>
                <option value="external" ${external ? 'selected' : ''}>${esc(t('realtime.phoneModeExternal'))}</option>
              </select>
            </label>
            <p class="rt-hint">${esc(t(!status.embeddedAvailable ? 'realtime.phoneEmbeddedMissing' : external ? 'realtime.phoneModeExternalHint' : 'realtime.phoneModeEmbeddedHint'))}</p>
            ${external ? `
              <div class="rt-phone-grid">
                <label class="rt-field">${esc(t('realtime.phoneHost'))}<input type="text" class="rt-phone-host" maxlength="200" spellcheck="false" value="${esc(settings.host)}" ${off}></label>
                <label class="rt-field">${esc(t('realtime.phonePort'))}<input type="number" class="rt-phone-port" min="1" max="65535" value="${esc(settings.port)}" ${off}></label>
                <label class="rt-field">${esc(t('realtime.phoneUser'))}<input type="text" class="rt-phone-user" maxlength="200" spellcheck="false" autocomplete="off" value="${esc(settings.user)}" ${off}></label>
                <label class="rt-field">${esc(t('realtime.phonePassword'))}<input type="password" class="rt-phone-password" maxlength="200" autocomplete="off" value="${esc(settings.password)}" ${off}></label>
              </div>
              <p class="rt-hint">${esc(t('realtime.phoneExternalLogin'))}</p>` : `
              <div class="rt-switch-row">
                <label class="synth-toggle-wrapper"><span class="synth-switch"><input type="checkbox" class="rt-phone-transit" ${settings.transit ? 'checked' : ''} ${off}><span class="synth-slider"></span></span>
                  <span><strong>${esc(t('realtime.phoneTransit'))}</strong><small>${esc(t('realtime.phoneTransitHint'))}</small></span></label>
              </div>
              <label class="rt-field">${esc(t('realtime.phoneBandwidth'))}
                <select class="rt-phone-bandwidth select-control" ${settings.transit ? off : 'disabled'}>
                  ${BANDWIDTHS.map(letter => `<option value="${letter}" ${settings.bandwidth === letter ? 'selected' : ''}>${esc(t('realtime.phoneBandwidth_' + letter))}</option>`).join('')}
                </select>
              </label>`}
            <label class="rt-field">${esc(t('realtime.phoneName'))}
              <input type="text" class="rt-phone-name" maxlength="60" value="${esc(settings.name)}" placeholder="${esc(status.name)}" ${off}>
            </label>
            <button type="submit" class="btn" ${off}>${esc(t('realtime.phoneRouterSave'))}</button>
          </form>
        </section>`;

      const left = this.phoneSecondsLeft(status);
      const pairing = status.pairing && left > 0
        ? `<div class="rt-phone-pairing">
            <div class="rt-phone-qr">${window.synthQr.svg(status.pairing.code, { title: t('realtime.phoneQrLabel') })}</div>
            <div class="rt-phone-pairing-text">
              <p>${esc(t('realtime.phonePairingHow'))}</p>
              <p class="rt-phone-left" role="timer">${esc(t('realtime.phonePairingLeft', { seconds: left }))}</p>
              <p>${esc(t('realtime.phonePairingText'))}</p>
              <code class="rt-phone-code">${esc(status.pairing.code)}</code>
              <div class="rt-row">
                <button type="button" class="btn" data-action="phone-pair-copy" ${off}><i class="fa-solid fa-copy"></i> ${esc(t('realtime.phonePairingCopy'))}</button>
                ${this.phoneCopied ? `<small class="rt-hint" role="status">${esc(this.phoneCopied)}</small>` : ''}
              </div>
              <p class="rt-hint">${esc(t('realtime.phonePairingSecret'))}</p>
              <button type="button" class="btn" data-action="phone-pair-cancel" ${off}>${esc(t('realtime.phonePairingCancel'))}</button>
            </div>
          </div>`
        : this.phoneBusy === 'pairing' || status.preparingPairing
          ? `<p class="rt-phone-phase" role="status"><i class="fa-solid fa-spinner fa-spin"></i> ${esc(t('realtime.phonePairingPreparing'))}</p>`
          : `<button type="button" class="btn btn-primary" data-action="phone-pair" ${(on || service) && ['ready', 'off'].includes(status.phase) ? off : 'disabled'}><i class="fa-solid fa-qrcode"></i> ${esc(t('realtime.phonePair'))}</button>
             ${on || service ? '' : `<p class="rt-hint">${esc(t('realtime.phonePairNeedsOn'))}</p>`}`;

      const devices = status.devices.length
        ? `<ul class="rt-list rt-phone-devices">${status.devices.map(device => (this.phoneRenaming === device.id
          ? `<li class="rt-memory is-editing">
              <form class="rt-phone-rename" data-id="${esc(device.id)}">
                <label class="rt-field">${esc(t('realtime.phoneDeviceName'))}<input type="text" class="rt-phone-device-name" maxlength="60" value="${esc(device.name)}"></label>
                <div class="rt-row">
                  <button type="submit" class="btn btn-primary">${esc(t('realtime.phoneSave'))}</button>
                  <button type="button" class="btn" data-action="phone-rename-cancel">${esc(t('common.cancel'))}</button>
                </div>
              </form>
            </li>`
          : `<li class="rt-memory">
              <i class="fa-solid fa-mobile-screen" aria-hidden="true"></i>
              <span class="rt-memory-text"><span>${esc(device.name)}</span>
                <small>${esc(device.connected ? t(device.via === 'lan' ? 'realtime.phoneDeviceConnectedLan' : 'realtime.phoneDeviceConnected') : device.lastSeenAt ? t('realtime.phoneDeviceSeen', { when: this.phoneWhen(device.lastSeenAt) }) : t('realtime.phoneDeviceNever'))}</small></span>
              <button type="button" class="btn-chat-action" data-action="phone-rename" data-id="${esc(device.id)}" title="${esc(t('realtime.phoneRename'))}" aria-label="${esc(t('realtime.phoneRename'))}" ${off}><i class="fa-solid fa-pen"></i></button>
              <button type="button" class="btn-chat-action" data-action="phone-remove" data-id="${esc(device.id)}" title="${esc(t('realtime.phoneRemove'))}" aria-label="${esc(t('realtime.phoneRemove'))}" ${off}><i class="fa-solid fa-trash"></i></button>
            </li>`)).join('')}</ul>`
        : `<p class="rt-hint">${esc(t('realtime.phoneNoDevices'))}</p>`;

      const phones = `
        <section class="rt-set-block">
          <h3>${esc(t('realtime.phoneDevicesTitle'))}</h3>
          ${devices}
          ${pairing}
        </section>`;

      const forget = `
        <section class="rt-set-block">
          <h3>${esc(t('realtime.phoneForgetTitle'))}</h3>
          <p class="rt-hint">${esc(t('realtime.phoneForgetHint'))}</p>
          ${this.phoneForgetAsked
            ? `<div class="rt-row">
                <button type="button" class="btn btn-danger-action" data-action="phone-forget-yes" ${off}>${esc(t('realtime.phoneForgetYes'))}</button>
                <button type="button" class="btn" data-action="phone-forget-no" ${off}>${esc(t('common.cancel'))}</button>
              </div>`
            : `<button type="button" class="btn" data-action="phone-forget" ${off}>${esc(t('realtime.phoneForget'))}</button>`}
        </section>`;

      return head + phones + router + forget;
    },

    /** While the page is open it follows the bridge: a phone that connects, a code that runs out. */
    phoneWatch() {
      if (!this.phoneUnwatch && bridge()) {
        this.phoneUnwatch = bridge().onStatus(() => this.phoneRenderPage());
        bridge().refresh().catch(() => {});
        bridge().readShell();
      }
      if (this.phoneClock) return;
      this.phoneClock = setInterval(() => {
        const open = this.phoneOpen();
        if (!open) {
          clearInterval(this.phoneClock);
          this.phoneClock = null;
          // The window was closed with a code still good: it is withdrawn.
          if (this.phoneStatus()?.pairing) window.chatStorage.bridgeClosePairing().then(status => bridge().setStatus(status)).catch(() => {});
          return;
        }
        const status = this.phoneStatus();
        const clock = this.phoneHost().querySelector('.rt-phone-left');
        // With the bridge off nothing tells the page what changes: it asks, every few seconds.
        if (!clock) { if (!bridge().running && ++this.phoneTicks % 5 === 0) bridge().refresh().catch(() => {}); return; }
        const left = this.phoneSecondsLeft(status);
        if (left > 0) clock.textContent = t('realtime.phonePairingLeft', { seconds: left });
        else { this.phoneNote = t('realtime.phonePairingExpired'); bridge().refresh().then(() => this.phoneRenderPage(true)).catch(() => {}); }
      }, 1000);
    },

    async phoneDo(what, run, done = '') {
      this.phoneBusy = what;
      this.phoneNote = '';
      this.phoneRenderPage(true);
      try {
        const status = await run();
        if (status) bridge().setStatus(status);
        this.phoneNote = done;
      } catch (err) {
        this.phoneNote = t('realtime.error', { error: err.message });
        try { await bridge().refresh(); } catch {}
      }
      this.phoneBusy = '';
      this.phoneRenderPage(true);
    },

    /** A click, a change or a form sent in the phone's page of the settings. */
    async onPhoneSettings(e) {
      const storage = window.chatStorage;
      const target = e.target;
      if (e.type === 'change') {
        if (target.matches('.rt-phone-on')) {
          const enabled = target.checked;
          await this.phoneDo('switch', () => storage.bridgeConfigure({ enabled }), enabled ? '' : t('realtime.phoneTurnedOff'));
          return true;
        }
        if (target.matches('.rt-phone-hops')) {
          const hops = Number(target.value);
          await this.phoneDo('service', () => storage.bridgeConfigure({ hops }), t('realtime.phoneHopsSet', { hops }));
          return true;
        }
        if (target.matches('.rt-phone-lan')) {
          const lan = target.checked;
          await this.phoneDo('service', () => storage.bridgeConfigure({ lan }), t(lan ? 'realtime.phoneLanOn' : 'realtime.phoneLanOff'));
          return true;
        }
        if (target.matches('.rt-phone-service')) {
          const service = target.checked;
          await this.phoneDo('service', () => storage.bridgeConfigure({ service }), t(service ? 'realtime.phoneServiceOn' : 'realtime.phoneServiceOff'));
          return true;
        }
        if (target.matches('.rt-phone-autostart')) {
          const autostart = target.checked;
          await this.phoneDo('service', async () => { await bridge().setAutostart(autostart); return null; }, t(autostart ? 'realtime.phoneAutostartOn' : 'realtime.phoneAutostartOff'));
          return true;
        }
        // Which router: the fields of the other one are shown, nothing is saved until the form is sent.
        if (target.matches('.rt-phone-mode')) {
          this.phoneDraft = { ...this.phoneDraft, mode: target.value };
          this.phoneRenderPage(true);
          return true;
        }
        if (target.matches('.rt-phone-transit')) {
          this.phoneDraft = { ...this.phoneDraft, transit: target.checked };
          this.phoneRenderPage(true);
          return true;
        }
        return false;
      }
      if (e.type === 'submit') {
        e.preventDefault();
        const rename = target.closest('.rt-phone-rename');
        if (rename) {
          const name = rename.querySelector('.rt-phone-device-name').value.trim();
          this.phoneRenaming = null;
          if (name) await this.phoneDo('device', () => storage.bridgeRenameDevice(rename.dataset.id, name), t('realtime.textSaved'));
          else this.phoneRenderPage(true);
          return true;
        }
        const form = target.closest('.rt-phone-router');
        if (form) {
          const value = (selector) => form.querySelector(selector)?.value;
          const change = { mode: value('.rt-phone-mode'), name: (value('.rt-phone-name') || '').trim() };
          if (change.mode === 'external') Object.assign(change, { host: (value('.rt-phone-host') || '').trim(), port: Number(value('.rt-phone-port')), user: value('.rt-phone-user') || '', password: value('.rt-phone-password') || '' });
          else Object.assign(change, { transit: form.querySelector('.rt-phone-transit').checked, bandwidth: value('.rt-phone-bandwidth') });
          this.phoneDraft = null;
          await this.phoneDo('router', () => storage.bridgeConfigure(change), t('realtime.textSaved'));
          return true;
        }
        return false;
      }
      const action = target.closest('button')?.dataset.action || '';
      if (!action.startsWith('phone-')) return false;
      const id = target.closest('button').dataset.id;
      if (action === 'phone-retry') await this.phoneDo('switch', () => storage.bridgeConfigure({ enabled: true }));
      else if (action === 'phone-pair') { this.phoneCopied = ''; await this.phoneDo('pairing', () => storage.bridgeOpenPairing()); }
      else if (action === 'phone-pair-cancel') await this.phoneDo('pairing', () => storage.bridgeClosePairing());
      else if (action === 'phone-pair-copy') {
        const code = this.phoneStatus()?.pairing?.code || '';
        try { await navigator.clipboard.writeText(code); this.phoneCopied = t('realtime.phonePairingCopied'); } catch (err) { this.phoneCopied = t('realtime.error', { error: err.message }); }
        this.phoneRenderPage(true);
      }
      else if (action === 'phone-rename') { this.phoneRenaming = id; this.phoneRenderPage(true); this.phoneHost().querySelector('.rt-phone-device-name')?.focus(); }
      else if (action === 'phone-rename-cancel') { this.phoneRenaming = null; this.phoneRenderPage(true); }
      else if (action === 'phone-remove') await this.phoneDo('device', () => storage.bridgeRemoveDevice(id), t('realtime.phoneRemoved'));
      else if (action === 'phone-forget') { this.phoneForgetAsked = true; this.phoneRenderPage(true); }
      else if (action === 'phone-forget-no') { this.phoneForgetAsked = false; this.phoneRenderPage(true); }
      else if (action === 'phone-forget-yes') { this.phoneForgetAsked = false; await this.phoneDo('forget', () => storage.bridgeForget(), t('realtime.phoneForgotten')); }
      return true;
    }
  });
})();
