/**
 * SynthOrg - the assistant's features.
 *
 * What the character may do by itself and how its questions are answered,
 * chosen by the user in the section's settings, page "Features":
 *   - delegate: it may hand tasks to the Master without asking. Off, every
 *     task is told to the user and starts only when they confirm it;
 *   - relay: it may write in the user's chats without asking. Off, every
 *     message is told to the user and written only when they confirm it;
 *   - voiceYes: the confirmation can be answered by voice. Off, it is
 *     answered with the buttons or in writing;
 *   - askOutcome: when a task made no file, the user is asked whether they
 *     want to hear what it found. Off, it is told at once.
 *
 * They are kept as one setting (realtime_features), which holds only what
 * differs from what they start out as. These are methods of the section's
 * object (realtime.js), kept in a file of their own.
 */
(function () {
  'use strict';

  const rt = window.realtime._state;
  const { t, esc } = window.realtime._util;
  // As the section starts out with them.
  const DEFAULTS = { ...rt.features };

  Object.assign(rt, {
    async loadFeatures() {
      let own = {};
      try { own = JSON.parse((await window.chatStorage.getSetting('realtime_features'))?.value || '{}') || {}; } catch {}
      this.features = { ...DEFAULTS };
      Object.keys(DEFAULTS).forEach(key => { if (typeof own[key] === typeof DEFAULTS[key]) this.features[key] = own[key]; });
    },

    async saveFeatures(change) {
      Object.keys(DEFAULTS).forEach(key => { if (typeof change[key] === typeof DEFAULTS[key]) this.features[key] = change[key]; });
      const own = Object.fromEntries(Object.entries(this.features).filter(([key, value]) => value !== DEFAULTS[key]));
      await window.chatStorage.setSetting('realtime_features', JSON.stringify(own));
      // A task waiting to be confirmed follows what was chosen: handed at once, or heard by voice or not.
      if (this.confirming && (this.confirming.outcome ? !this.features.askOutcome : this.confirming.send ? this.features.relay : this.features.delegate)) await this.confirmTask(true);
      this.listenAgain();
    },

    renderSettings_features() {
      const toggle = (key, off = false) => `<div class="rt-switch-row">
          <label class="synth-toggle-wrapper"><span class="synth-switch"><input type="checkbox" class="rt-feature-flag" data-key="${key}" ${this.features[key] ? 'checked' : ''} ${off ? 'disabled' : ''}><span class="synth-slider"></span></span>
            <span><strong>${esc(t('realtime.feature' + key[0].toUpperCase() + key.slice(1)))}</strong><small>${esc(t('realtime.feature' + key[0].toUpperCase() + key.slice(1) + 'Hint'))}</small></span></label>
        </div>`;
      return `
        <section class="rt-set-block">
          <h3>${esc(t('realtime.featuresTitle'))}</h3>
          <p class="rt-hint">${esc(t('realtime.featuresHint', { name: this.displayName() }))}</p>
          ${this.settingsNote ? `<p class="rt-hint" role="status">${esc(this.settingsNote)}</p>` : ''}
          ${toggle('delegate')}
          ${toggle('relay')}
          ${toggle('askOutcome')}
          ${toggle('voiceYes', this.features.delegate && this.features.relay && !this.features.askOutcome)}
        </section>`;
    },

    /** A change in the features' page of the settings. */
    async onFeaturesSettings(e) {
      const target = e.target;
      if (e.type !== 'change' || !target.matches('.rt-feature-flag')) return false;
      try {
        await this.saveFeatures({ [target.dataset.key]: target.checked });
        this.settingsNote = t('realtime.textSaved');
      } catch (err) {
        this.settingsNote = t('realtime.error', { error: err.message });
      }
      this.renderSettings(true);
      return true;
    }
  });

  window.realtime._features = { DEFAULTS };
})();
