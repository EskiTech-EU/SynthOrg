/* Conversation navigation and user-managed long-term memory. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);

  // The dossier's global switch. It used to live only in this browser's
  // storage: a value left there is carried to the server once, then dropped.
  const OLD_DOSSIER_KEY = 'synthorg_global_memory_enabled';
  async function globalDossierEnabled() {
    let old = null;
    try { old = localStorage.getItem(OLD_DOSSIER_KEY); } catch {}
    if (old !== null) {
      await window.chatStorage.setSetting('global_memory_enabled', old === 'false' ? 'false' : 'true');
      try { localStorage.removeItem(OLD_DOSSIER_KEY); } catch {}
      return old !== 'false';
    }
    const res = await window.chatStorage.getSetting('global_memory_enabled');
    return res?.value !== 'false';
  }

  class ChatWorkspace {
    constructor() {
      this.chats = [];
      this.memories = [];
      this.query = '';
      this.archived = false;
      // The list shown: the chats, the archived ones, or the chats of the assistant.
      this.mo = false;
      // Several chats picked in the list, for the buttons under it.
      this.selecting = false;
      this.selected = new Set();
      this.listRequest = 0;
      this.memoryRequest = 0;
      this.activeMemoryScope = 'global';
    }
    bind() {
      $('btn-new-chat').addEventListener('click', () => this.perform(() => this.newChat()));
      $('btn-retry-storage')?.addEventListener('click', () => window.chatManager.initialize());
      $('btn-dismiss-storage-error')?.addEventListener('click', () => {
        const errEl = $('chat-storage-error');
        if (errEl) errEl.hidden = true;
      });
      $('chat-search').addEventListener('input', e => { this.query = e.target.value; clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.perform(() => this.refresh()), 150); });
      $('btn-chats-archived').addEventListener('click', () => this.perform(() => this.showList('archived')));
      $('btn-chats-mo').addEventListener('click', () => this.perform(() => this.showList('mo')));
      $('btn-chats-back').addEventListener('click', () => this.perform(() => this.showList('chats')));
      $('btn-chats-select').addEventListener('click', () => this.setSelecting(!this.selecting));
      $('btn-open-global-memory')?.addEventListener('click', () => this.perform(() => this.openGlobalMemories()));
      $('btn-open-chat-memory')?.addEventListener('click', () => this.perform(() => this.openChatMemories()));
      $('global-memory-form')?.addEventListener('submit', e => { e.preventDefault(); this.perform(() => this.saveGlobalMemory()); });
      $('btn-global-memory-new')?.addEventListener('click', () => this.resetGlobalMemoryForm());
      $('global-memory-search')?.addEventListener('input', () => { clearTimeout(this.globalMemoryTimer); this.globalMemoryTimer = setTimeout(() => this.perform(() => this.loadGlobalMemories()), 150); });
      $('chat-memory-form')?.addEventListener('submit', e => { e.preventDefault(); this.perform(() => this.saveChatMemory()); });
      $('btn-chat-memory-new')?.addEventListener('click', () => this.resetChatMemoryForm());
      $('chat-memory-search')?.addEventListener('input', () => { clearTimeout(this.chatMemoryTimer); this.chatMemoryTimer = setTimeout(() => this.perform(() => this.loadChatMemories()), 150); });
      $('btn-rename-chat')?.addEventListener('click', () => {
        const chat = window.chatManager.conversation;
        if (chat) this.renameChat(chat.id);
      });
      $('chat-rename-form').addEventListener('submit', e => { e.preventDefault(); this.perform(async () => {
        const chat = await window.chatStorage.update(this.renameId, { title: $('chat-rename-input').value });
        if (window.chatManager.conversation?.id === chat.id) window.chatManager.conversation = chat;
        $('chat-rename-dialog').close(); await this.refresh();
      }); });
      $('btn-archive-chat').addEventListener('click', () => this.perform(() => this.archiveChosen()));
      $('btn-delete-chat').addEventListener('click', () => this.perform(() => this.deleteChosen()));
      $('chat-memory-enabled')?.addEventListener('change', e => this.perform(async () => {
        const manager = window.chatManager;
        const id = manager.conversation?.id;
        if (!id) return;
        try {
          const updated = await window.chatStorage.update(id, { memoryEnabled: e.target.checked });
          if (manager.conversation?.id === id) manager.conversation = updated;
        }
        finally { this.renderActive(); }
      }));
      $('btn-cancel-chat-memory')?.addEventListener('click', () => this.closeChatMemoryEditor());
      $('btn-cancel-chat-memory-footer')?.addEventListener('click', () => this.closeChatMemoryEditor());
      document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $(button.dataset.closeDialog).close()));
    }
    async perform(action) { try { await action(); } catch (error) { this.error(error); } }
    error(error) {
      const errEl = $('chat-storage-error');
      if (errEl) { errEl.hidden = false; $('chat-storage-error-text').textContent = error.message; }
      if ($('global-memory-dialog')?.open) $('global-memory-form-error').textContent = error.message;
      if ($('chat-memory-dialog')?.open) $('chat-memory-form-error').textContent = error.message;
    }
    async newChat() {
      const chat = await window.chatStorage.create();
      this.archived = false; this.mo = false; this.query = ''; $('chat-search').value = '';
      this.setSelecting(false);
      await window.chatManager.selectConversation(chat.id); await this.refresh();
    }
    /** Which list the column shows: 'chats', 'archived' or 'mo'. */
    async showList(name) {
      this.archived = name === 'archived';
      this.mo = name === 'mo';
      this.setSelecting(false);
      await this.refresh();
    }
    /** Picking several chats: a click on a row picks it instead of opening it. */
    setSelecting(on) {
      this.selecting = Boolean(on) && !this.mo;
      this.selected.clear();
      $('btn-chats-select').setAttribute('aria-pressed', String(this.selecting));
      $('conversation-list').classList.toggle('is-selecting', this.selecting);
      $('conversation-list').querySelectorAll('.conversation-item').forEach(item => this.markPicked(item));
    }
    markPicked(item) {
      const picked = this.selected.has(item.dataset.conversation);
      item.classList.toggle('is-picked', picked);
      item.setAttribute('aria-selected', String(picked));
      const icon = item.querySelector('.conversation-pick i');
      if (icon) icon.className = picked ? 'fa-solid fa-square-check' : 'fa-regular fa-square';
    }
    /** What the buttons under the list act on: the chats picked or, with none picked, the open one. */
    chosen() {
      if (this.selecting) return [...this.selected];
      const open = window.chatManager.conversation;
      return open && this.chats.some(chat => chat.id === open.id) ? [open.id] : [];
    }
    async archiveChosen() {
      const ids = this.chosen();
      if (!ids.length) throw new Error(window.i18n.t('shell.noneSelected'));
      for (const id of ids) {
        const chat = this.chats.find(c => c.id === id);
        if (!chat) continue;
        const updated = await window.chatStorage.update(chat.id, { archived: !chat.archived });
        if (window.chatManager.conversation?.id === chat.id) window.chatManager.conversation = updated;
      }
      this.setSelecting(false);
      await this.refresh();
    }
    async deleteChosen() {
      const ids = this.chosen();
      if (!ids.length) throw new Error(window.i18n.t('shell.noneSelected'));
      if (ids.length === 1) { await this.deleteChat(ids[0]); this.setSelecting(false); return; }
      const manager = window.chatManager;
      if (ids.includes(manager.generation?.conversationId)) throw new Error(window.i18n.t('chat.waitBeforeDelete'));
      const confirmed = await this.confirmAction({
        title: window.i18n.t('dialog.confirmDeleteTitle'),
        message: window.i18n.t('shell.deleteManyMessage', { count: ids.length }),
        confirmText: window.i18n.t('common.delete')
      });
      if (!confirmed) return;
      for (const id of ids) await window.chatStorage.remove(id);
      if (ids.includes(manager.conversation?.id)) {
        const remaining = await window.chatStorage.list();
        await manager.selectConversation(remaining[0]?.id || (await window.chatStorage.create()).id);
      }
      this.setSelecting(false);
      await this.refresh();
    }
    async renameChat(id) {
      const chat = this.chats.find(c => c.id === id) || (window.chatManager.conversation?.id === id ? window.chatManager.conversation : null);
      if (!chat) return;
      this.renameId = chat.id;
      $('chat-rename-input').value = chat.title;
      $('chat-rename-dialog').showModal();
    }
    async archiveChat(id) {
      const chat = this.chats.find(c => c.id === id) || (window.chatManager.conversation?.id === id ? window.chatManager.conversation : null);
      if (!chat) return;
      const updated = await window.chatStorage.update(chat.id, { archived: !chat.archived });
      if (window.chatManager.conversation?.id === chat.id) window.chatManager.conversation = updated;
      await this.refresh();
    }
    confirmAction({ title, message, confirmText }) {
      return new Promise(resolve => {
        const dialog = $('chat-confirm-dialog');
        const titleEl = $('confirm-dialog-title');
        const msgEl = $('confirm-dialog-message');
        const okBtn = $('confirm-dialog-ok');
        const cancelBtn = $('confirm-dialog-cancel');

        const resolvedTitle = title || (window.i18n ? window.i18n.t('dialog.confirmDeleteTitle') : 'Conferma');
        const resolvedConfirmText = confirmText || (window.i18n ? window.i18n.t('common.delete') : 'Elimina');

        if (!dialog) return resolve(window.confirm(message));

        if (titleEl) titleEl.textContent = resolvedTitle;
        if (msgEl) msgEl.textContent = message;
        if (okBtn) okBtn.textContent = resolvedConfirmText;

        let settled = false;
        const cleanup = (result) => {
          if (settled) return;
          settled = true;
          dialog.removeEventListener('close', onClose);
          okBtn.removeEventListener('click', onOk);
          cancelBtn.removeEventListener('click', onCancel);
          if (dialog.open) dialog.close();
          resolve(result);
        };

        const onOk = (e) => { e.preventDefault(); cleanup(true); };
        const onCancel = (e) => { e.preventDefault(); cleanup(false); };
        const onClose = () => cleanup(false);

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        dialog.addEventListener('close', onClose);

        dialog.showModal();
        okBtn.focus();
      });
    }
    async deleteChat(id) {
      const manager = window.chatManager;
      const chat = this.chats.find(c => c.id === id) || (this.realtimeTasks?.id === id ? this.realtimeTasks : null) || (manager.conversation?.id === id ? manager.conversation : null);
      if (!chat) return;
      const shownTitle = chat.kind === 'realtime_tasks' ? window.i18n.t('chat.realtimeTasks') : chat.title;
      if (manager.generation?.conversationId === chat.id) {
        throw new Error(window.i18n ? window.i18n.t('chat.waitBeforeDelete') : 'Attendi la fine della risposta prima di eliminare questa chat.');
      }
      const confirmed = await this.confirmAction({
        title: window.i18n ? window.i18n.t('dialog.confirmDeleteTitle') : 'Elimina chat',
        message: window.i18n 
          ? window.i18n.t('dialog.confirmDeleteMessage', { title: shownTitle }) 
          : `Eliminare “${chat.title}”, i messaggi e le memorie della chat? Le memorie globali saranno conservate.`,
        confirmText: window.i18n ? window.i18n.t('dialog.confirmDeleteBtn') : 'Elimina chat'
      });
      if (!confirmed) return;
      await window.chatStorage.remove(chat.id);
      if (manager.conversation?.id === chat.id) {
        const remaining = await window.chatStorage.list();
        if (manager.conversation?.id === chat.id) await manager.selectConversation(remaining[0]?.id || (await window.chatStorage.create()).id);
      }
      await this.refresh();
    }
    async refresh() {
      const request = ++this.listRequest;
      const chats = this.mo ? [] : await window.chatStorage.list(this.query, this.archived);
      // The Realtime tasks chat is not in that list: it gets its own place.
      let realtimeTasks = null;
      try { realtimeTasks = (await window.chatStorage.realtime()).tasks; } catch {}
      // Storage answers, so the old switch can be carried over before the first turn reads it.
      this.dossierMigrated ||= globalDossierEnabled().catch(() => { this.dossierMigrated = null; });
      if (request !== this.listRequest) return;
      this.chats = chats;
      const manager = window.chatManager;
      const active = chats.find(chat => chat.id === manager.conversation?.id);
      if (active) manager.conversation = active;
      this.realtimeTasks = realtimeTasks;
      this.renderRealtimeTasks(realtimeTasks);
      const renameLabel = window.i18n ? window.i18n.t('chat.renameAction') : 'Rinomina chat';
      const deleteLabel = window.i18n ? window.i18n.t('chat.deleteAction') : 'Elimina chat';
      for (const id of [...this.selected]) if (!chats.some(chat => chat.id === id)) this.selected.delete(id);
      // Inside the archive or MO's chats the column is that place: its name, the way back, its list.
      const inside = this.archived || this.mo;
      $('btn-new-chat').hidden = inside;
      $('conversation-sidebar-nav').hidden = inside;
      $('btn-chats-back').hidden = !inside;
      $('chats-back-label').textContent = inside ? window.i18n.t(this.mo ? 'shell.moChats' : 'shell.archived') : '';
      $('chat-search').closest('.conversation-search').classList.toggle('is-off', this.mo);
      $('chat-search').disabled = this.mo;
      $('btn-chats-select').disabled = this.mo;
      $('conversation-list').classList.toggle('is-selecting', this.selecting);

      const respondingText = window.i18n ? window.i18n.t('chat.responding') : 'In risposta…';
      const emptyText = this.mo
        ? (realtimeTasks ? '' : window.i18n.t('shell.moEmpty'))
        : (window.i18n ? window.i18n.t('chat.emptyList') : 'Nessuna chat trovata.');

      // A row is the chat's name: what is done to a chat is in the buttons under the list.
      $('conversation-list').innerHTML = chats.map(chat => {
        const active = manager.conversation?.id === chat.id;
        const picked = this.selected.has(chat.id);
        return `
        <div class="conversation-item ${active ? 'active' : ''} ${picked ? 'is-picked' : ''}" data-conversation="${chat.id}" role="button" tabindex="0" aria-current="${active ? 'true' : 'false'}" aria-selected="${picked}">
          <span class="conversation-pick" aria-hidden="true"><i class="${picked ? 'fa-solid fa-square-check' : 'fa-regular fa-square'}"></i></span>
          <div class="conversation-name-wrap">
            <span class="conversation-name" title="${window.escapeHtml(chat.title)}">${window.escapeHtml(chat.title)}</span>
            ${chat.world === 'other' ? `<em class="conversation-world">${window.i18n ? window.i18n.t('chat.otherDevice') : 'altro dispositivo'}</em>` : ''}
          </div>
          ${manager.generation?.conversationId === chat.id ? `<i class="fa-solid fa-circle-notch spinning conversation-busy" title="${respondingText}"></i>` : ''}
          <div class="conversation-item-actions">
            <button type="button" class="conversation-action-btn" data-chat-action="rename" title="${renameLabel}" aria-label="${renameLabel}"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="conversation-action-btn conversation-action-delete" data-chat-action="delete" title="${deleteLabel}" aria-label="${deleteLabel}"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>`;
      }).join('') || (emptyText ? `<p class="conversation-empty">${emptyText}</p>` : '');

      const items = $('conversation-list').querySelectorAll('.conversation-item');
      items.forEach(item => {
        const open = () => {
          if (this.selecting) {
            const id = item.dataset.conversation;
            if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
            this.markPicked(item);
            return;
          }
          this.perform(async () => {
            await manager.selectConversation(item.dataset.conversation);
            await this.refresh();
          });
        };
        item.addEventListener('click', (e) => {
          const action = e.target.closest('[data-chat-action]')?.dataset.chatAction;
          if (action === 'rename') this.perform(() => this.renameChat(item.dataset.conversation));
          else if (action === 'delete') this.perform(() => this.deleteChat(item.dataset.conversation));
          else open();
        });
        item.addEventListener('keydown', (e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('[data-chat-action]')) { e.preventDefault(); open(); }
        });
        // Title scroll on hover
        item.addEventListener('mouseenter', () => {
          const nameEl = item.querySelector('.conversation-name');
          const wrapEl = item.querySelector('.conversation-name-wrap');
          if (nameEl && wrapEl) {
            const diff = nameEl.scrollWidth - wrapEl.clientWidth;
            if (diff > 2) {
              const duration = Math.max(1.8, Math.min(8, diff / 25));
              nameEl.style.setProperty('--scroll-dist', `-${diff + 6}px`);
              nameEl.style.animation = `chatTitleMarquee ${duration}s ease-in-out infinite alternate`;
            }
          }
        });
        item.addEventListener('mouseleave', () => {
          const nameEl = item.querySelector('.conversation-name');
          if (nameEl) {
            nameEl.style.animation = '';
            nameEl.style.transform = '';
          }
        });
      });

      this.renderActive();
    }
    /**
     * The chat where the Master does what the Realtime character hands over:
     * the list of the assistant's chats, shown in place of the others.
     */
    renderRealtimeTasks(tasks) {
      const slot = $('realtime-tasks-slot');
      if (!slot) return;
      const show = Boolean(tasks) && this.mo;
      slot.hidden = !show;
      if (!show) { slot.innerHTML = ''; return; }
      const manager = window.chatManager;
      const t = (key, fallback) => (window.i18n ? window.i18n.t(key) : fallback);
      const isActive = manager.conversation?.id === tasks.id;
      const running = manager.backgroundRuns?.has?.(tasks.id);
      slot.innerHTML = `
        <div class="conversation-item conversation-item-realtime ${isActive ? 'active' : ''}" data-conversation="${tasks.id}" role="button" tabindex="0" aria-current="${isActive}" title="${window.escapeHtml(t('chat.realtimeTasksHint', ''))}">
          <div class="conversation-name-wrap">
            <span class="conversation-name">${window.escapeHtml(t('chat.realtimeTasks', 'Compiti dell’assistente'))}</span>
          </div>
          ${running ? `<i class="fa-solid fa-circle-notch spinning conversation-busy" title="${window.escapeHtml(t('chat.responding', 'In risposta…'))}"></i>` : ''}
          <div class="conversation-item-actions">
            <button type="button" class="conversation-action-btn conversation-action-delete" data-chat-action="delete" title="${window.escapeHtml(t('chat.deleteAction', 'Elimina chat'))}" aria-label="${window.escapeHtml(t('chat.deleteAction', 'Elimina chat'))}"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>`;
      const item = slot.firstElementChild;
      const open = () => this.perform(async () => {
        await manager.selectConversation(tasks.id);
        await this.refresh();
      });
      item.addEventListener('click', (e) => {
        if (e.target.closest('[data-chat-action="delete"]')) this.perform(() => this.deleteChat(tasks.id));
        else open();
      });
      item.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('[data-chat-action]')) { e.preventDefault(); open(); } });
    }
    renderActive() {
      const chat = window.chatManager.conversation;
      // In the archive the same button brings a chat back.
      const archive = $('btn-archive-chat');
      const archiveLabel = window.i18n ? window.i18n.t(this.archived ? 'shell.restore' : 'shell.archive') : 'Archivia';
      archive.querySelector('span').textContent = archiveLabel;
      archive.querySelector('i').className = this.archived ? 'fa-solid fa-box-open' : 'fa-solid fa-box-archive';
      const chatMemoryEnabled = $('chat-memory-enabled');
      if (chatMemoryEnabled) {
        chatMemoryEnabled.checked = Boolean(chat?.memory_enabled);
        chatMemoryEnabled.disabled = !chat;
      }
      const chatMem = $('btn-open-chat-memory');
      if (chatMem) chatMem.disabled = !chat || Boolean(window.chatManager?.isGenerating);
    }
    // =========================================================================
    // 1. DEDICATED GLOBAL MEMORIES (Dossier Globale)
    // =========================================================================
    async openGlobalMemories() {
      this.resetGlobalMemoryForm();
      const searchEl = $('global-memory-search');
      if (searchEl) searchEl.value = '';
      this.globalActiveSectionFilter = 'all';

      // The dossier's one global switch, kept by the server: each chat has its own beside it.
      const toggleEl = $('toggle-global-memory-active');
      if (toggleEl) {
        toggleEl.checked = await globalDossierEnabled();
        toggleEl.onchange = async () => {
          const on = toggleEl.checked;
          try { await window.chatStorage.setSetting('global_memory_enabled', on ? 'true' : 'false'); }
          catch (error) { toggleEl.checked = !on; this.error(error); return; }
          window.chatManager?.updateHeaderCounts?.();
        };
      }

      // Setup section pills
      const pillsContainer = $('global-section-pills');
      if (pillsContainer) {
        pillsContainer.querySelectorAll('.section-pill').forEach(pill => {
          pill.onclick = () => {
            pillsContainer.querySelectorAll('.section-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            this.globalActiveSectionFilter = pill.dataset.section || 'all';
            this.renderGlobalMemoriesList();
          };
        });
      }

      $('global-memory-dialog')?.showModal();
      await this.loadGlobalMemories();
    }

    resetGlobalMemoryForm() {
      this.editGlobalMemoryId = null;
      $('global-memory-content').value = '';
      const sectionEl = $('global-memory-section');
      if (sectionEl) sectionEl.value = 'general_notes';
      const enabledEl = $('global-memory-enabled');
      if (enabledEl) enabledEl.checked = true;
      const titleEl = $('global-memory-editor-title');
      if (titleEl) titleEl.textContent = window.i18n ? window.i18n.t('memory.newSharedTitle') : 'Nuova voce dossier';
      const errEl = $('global-memory-form-error');
      if (errEl) errEl.textContent = '';
    }

    async loadGlobalMemories() {
      const query = $('global-memory-search')?.value || '';
      const items = await window.chatStorage.memories(null, query, 'global');
      this.globalMemories = items;
      try { this.dossierProjects = await window.chatStorage.request('/memories/code-projects'); } catch { this.dossierProjects = null; }
      this.renderGlobalMemoriesList();
    }

    renderGlobalMemoriesList() {
      const items = this.globalMemories || [];
      const filter = this.globalActiveSectionFilter || 'all';
      const filtered = filter === 'all' ? items : items.filter(m => (m.section || 'general_notes') === filter);

      const emptyMsg = window.i18n ? window.i18n.t('memory.emptyShared') : 'Nessuna voce trovata per questa sezione del dossier.';
      const editLabel = window.i18n ? window.i18n.t('common.edit') : 'Modifica';
      const deleteLabel = window.i18n ? window.i18n.t('common.delete') : 'Elimina';
      const disableLabel = window.i18n ? window.i18n.t('common.disable') : 'Disattiva';
      const activeLabel = window.i18n ? window.i18n.t('common.active') : 'Attiva';

      const sectionLabels = {
        user_profile: window.i18n ? window.i18n.t('memory.sectionProfile') : 'Profilo',
        preferences: window.i18n ? window.i18n.t('memory.sectionPreferences') : 'Preferenze',
        active_projects: window.i18n ? window.i18n.t('memory.sectionActiveProjects') : 'Progetti Attivi',
        archive_projects: window.i18n ? window.i18n.t('memory.sectionArchive') : 'Storico',
        general_notes: window.i18n ? window.i18n.t('memory.sectionNotes') : 'Note Generali'
      };

      const listEl = $('global-memory-list');
      if (!listEl) return;

      // The Code projects: worked out from the projects, not editable here.
      const projects = this.dossierProjects;
      const generated = projects ? [
        ...(projects.active || []).map(p => ({ p, section: 'active_projects' })),
        ...(projects.past || []).map(p => ({ p, section: 'archive_projects' }))
      ].filter(g => filter === 'all' || g.section === filter) : [];
      const generatedHtml = generated.map(({ p, section }) => `
        <article class="memory-item memory-generated">
          <div class="memory-item-header">
            <span class="memory-tag-section"><i class="fa-solid fa-code"></i> ${sectionLabels[section]}</span>
            <span class="memory-item-meta">${window.i18n ? window.i18n.t('memory.generatedFromCode') : 'Da Code, aggiornata da sola'}</span>
          </div>
          <p>${window.escapeHtml(p.name)} — ${window.escapeHtml(p.kind === 'container' ? (window.i18n ? window.i18n.t('memory.projectContainer') : 'container isolato') : (window.i18n ? window.i18n.t('memory.projectLocal') : 'cartella di questo computer'))}${p.repo ? ' · GitHub ' + window.escapeHtml(p.repo) + (p.branch ? ' (' + window.escapeHtml(p.branch) + ')' : '') : ''} · ${window.i18n ? window.i18n.t('memory.lastOpened', { date: p.lastOpened }) : 'ultima apertura ' + p.lastOpened}</p>
        </article>`).join('');

      listEl.innerHTML = generatedHtml + filtered.map(item => {
        const statusLabel = item.enabled 
          ? (window.i18n ? window.i18n.t('memory.statusActive') : 'Attiva') 
          : (window.i18n ? window.i18n.t('memory.statusDisabled') : 'Disattivata');
        const sectionBadge = sectionLabels[item.section || 'general_notes'] || 'Note Generali';

        return `
        <article class="memory-item ${item.enabled ? '' : 'memory-disabled'}">
          <div class="memory-item-header">
            <span class="memory-tag-section"><i class="fa-solid fa-folder-open"></i> ${sectionBadge}</span>
            <span class="memory-item-meta">${statusLabel}</span>
          </div>
          <p>${window.escapeHtml(item.content)}</p>
          <div class="memory-item-actions">
            <button class="btn" data-edit-global-memory="${item.id}">${editLabel}</button>
            <button class="btn" data-toggle-global-memory="${item.id}">${item.enabled ? disableLabel : activeLabel}</button>
            <button class="btn btn-danger-outline" data-delete-global-memory="${item.id}">${deleteLabel}</button>
          </div>
        </article>`;
      }).join('') || `<p class="conversation-empty">${emptyMsg}</p>`;

      listEl.querySelectorAll('[data-edit-global-memory]').forEach(button => button.addEventListener('click', () => {
        const item = items.find(x => x.id === button.dataset.editGlobalMemory);
        if (!item) return;
        this.editGlobalMemoryId = item.id;
        $('global-memory-content').value = item.content;
        const sectionEl = $('global-memory-section');
        if (sectionEl) sectionEl.value = item.section || 'general_notes';
        const enabledEl = $('global-memory-enabled');
        if (enabledEl) enabledEl.checked = Boolean(item.enabled);
        const titleEl = $('global-memory-editor-title');
        if (titleEl) titleEl.textContent = window.i18n ? window.i18n.t('memory.editTitle') : 'Modifica voce dossier';
        const errEl = $('global-memory-form-error');
        if (errEl) errEl.textContent = '';
        $('global-memory-content').focus();
      }));

      listEl.querySelectorAll('[data-toggle-global-memory]').forEach(button => button.addEventListener('click', () => this.perform(async () => {
        const item = items.find(x => x.id === button.dataset.toggleGlobalMemory);
        if (!item) return;
        await window.chatStorage.saveMemory({
          content: item.content,
          scope: 'global',
          section: item.section || 'general_notes',
          conversationId: null,
          sourceMessageId: item.source_message_id,
          enabled: !item.enabled,
          pinned: true
        }, item.id);
        await this.loadGlobalMemories();
      })));

      listEl.querySelectorAll('[data-delete-global-memory]').forEach(button => button.addEventListener('click', () => this.perform(async () => {
        const confirmed = await this.confirmAction({
          title: window.i18n ? window.i18n.t('memory.deleteConfirmTitle') : 'Elimina memoria',
          message: window.i18n ? window.i18n.t('memory.deleteConfirmMessage') : 'Eliminare questa voce dal dossier? Non sarà più inclusa nelle risposte future.',
          confirmText: window.i18n ? window.i18n.t('memory.deleteConfirmBtn') : 'Elimina voce'
        });
        if (!confirmed) return;
        await window.chatStorage.deleteMemory(button.dataset.deleteGlobalMemory);
        if (this.editGlobalMemoryId === button.dataset.deleteGlobalMemory) this.resetGlobalMemoryForm();
        await this.loadGlobalMemories();
      })));
    }

    async saveGlobalMemory() {
      const saveBtn = $('btn-global-memory-save');
      if (saveBtn) saveBtn.disabled = true;
      try {
        await window.chatStorage.saveMemory({
          content: $('global-memory-content').value,
          section: $('global-memory-section')?.value || 'general_notes',
          scope: 'global',
          conversationId: null,
          enabled: $('global-memory-enabled')?.checked ?? true,
          pinned: true
        }, this.editGlobalMemoryId);
        this.resetGlobalMemoryForm();
        await this.loadGlobalMemories();
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    }

    // =========================================================================
    // 2. DEDICATED CHAT MEMORIES (Questa Chat - Timeline Turni)
    // =========================================================================
    async openChatMemories(message) {
      if (!window.chatManager.conversation) return;
      const chat = window.chatManager.conversation;
      this.resetChatMemoryForm();
      const searchEl = $('chat-memory-search');
      if (searchEl) searchEl.value = '';

      const titleEl = $('chat-memory-dialog-title');
      const descEl = $('chat-memory-dialog-desc');
      const chatTitle = chat.title ? `“${chat.title}”` : (window.i18n ? window.i18n.t('memory.thisChat') : 'questa chat');
      if (titleEl) titleEl.innerHTML = `<i class="fa-solid fa-comments" style="color: var(--primary);"></i> <span>${window.i18n ? window.i18n.t('memory.chatScopeTitle') : 'Memorie di questa Chat (Timeline Turni)'}</span>`;
      if (descEl) descEl.textContent = window.i18n ? window.i18n.t('memory.chatTimelineDesc', { title: chatTitle }) : `Cronologia e riassunti turno per turno per ${chatTitle}.`;

      // Setup dual activation toggles: Local turn memory and Global dossier inclusion
      const toggleEl = $('toggle-chat-memory-active');
      if (toggleEl) {
        toggleEl.checked = Boolean(chat.memory_enabled);
        toggleEl.onchange = async () => {
          await window.chatStorage.update(chat.id, { memory_enabled: toggleEl.checked });
          chat.memory_enabled = toggleEl.checked ? 1 : 0;
          const barCheck = $('chat-memory-enabled');
          if (barCheck) barCheck.checked = toggleEl.checked;
          window.chatManager?.updateHeaderCounts?.();
        };
      }

      const toggleGlobalEl = $('toggle-chat-include-global');
      if (toggleGlobalEl) {
        toggleGlobalEl.checked = chat.global_memory_enabled !== undefined ? Boolean(chat.global_memory_enabled) : true;
        toggleGlobalEl.onchange = async () => {
          await window.chatStorage.update(chat.id, { global_memory_enabled: toggleGlobalEl.checked });
          chat.global_memory_enabled = toggleGlobalEl.checked ? 1 : 0;
        };
      }

      if (message) {
        let contentToStore = (message.content || '').trim();
        let sourceId = message.id;
        const allMsgs = window.chatManager?.messages || [];
        const msgIdx = allMsgs.findIndex(m => m.id === message.id);

        let userText = '';
        let botText = '';

        if (msgIdx !== -1) {
          if (message.role === 'user') {
            userText = message.content || '';
            const nextMsg = allMsgs[msgIdx + 1];
            if (nextMsg && nextMsg.role === 'assistant') {
              botText = nextMsg.content || '';
              sourceId = nextMsg.id;
            }
          } else if (message.role === 'assistant') {
            botText = message.content || '';
            const prevMsg = allMsgs[msgIdx - 1];
            if (prevMsg && prevMsg.role === 'user') {
              userText = prevMsg.content || '';
            }
          }
        }

        const cleanUser = userText.trim();
        const cleanAssistant = botText
          .replace(/<(think|thought|reasoning|reflection)[^>]*>[\s\S]*?<\/\1>/gi, '')
          .replace(/<(think|thought|reasoning|reflection)[^>]*>[\s\S]*$/gi, '')
          .trim();

        if (cleanUser && cleanAssistant) {
          contentToStore = `Utente: ${cleanUser}\n\nRisposta: ${cleanAssistant}`;
        } else if (cleanUser) {
          contentToStore = `Utente: ${cleanUser}`;
        } else if (cleanAssistant) {
          contentToStore = `Risposta: ${cleanAssistant}`;
        }

        if (contentToStore.length > 1950) {
          const userPart = cleanUser.length > 500 ? cleanUser.slice(0, 497) + '...' : cleanUser;
          const prefix = `Utente: ${userPart}\n\nRisposta: `;
          const maxBotLen = 1950 - prefix.length - 3;
          const botPart = cleanAssistant.slice(0, Math.max(100, maxBotLen)) + '...';
          contentToStore = `${prefix}${botPart}`;
        }

        this.selectChatMemoryForEdit({
          id: null,
          content: contentToStore,
          source_message_id: sourceId,
          enabled: true
        });
      } else {
        this.closeChatMemoryEditor();
      }

      $('chat-memory-dialog')?.showModal();
      await this.loadChatMemories();
      await this.loadMemoryLevels();
    }

    /**
     * The level memory of the open chat: the cap and the share (for every chat),
     * where the model's view stands, and the tree of summaries, each node
     * opening onto the ones it contains.
     */
    async loadMemoryLevels() {
      const chat = window.chatManager.conversation;
      const box = $('memory-levels');
      if (!chat || !box) return;
      const t = (key, params) => (window.i18n ? window.i18n.t(key, params || {}) : key);
      let tree;
      try { tree = await window.chatStorage.memoryTree(chat.id); }
      catch (error) { $('memory-levels-status').textContent = error.message; return; }

      // The values this chat works with: the global ones (Settings), read-only here,
      // or its own once "own values" is on.
      const cap = $('memory-levels-cap'), share = $('memory-levels-share'), recent = $('memory-levels-recent'), own = $('memory-levels-own');
      cap.value = tree.settings.cap;
      share.value = Math.round(tree.settings.share * 100);
      recent.value = tree.settings.keepRaw;
      own.checked = Boolean(tree.own);
      for (const field of [cap, share, recent]) field.disabled = !own.checked;
      const values = () => ({
        cap: Math.max(4000, parseInt(cap.value, 10) || tree.settings.cap),
        share: Math.min(90, Math.max(0, parseInt(share.value, 10) || 0)) / 100,
        keepRaw: Math.min(50, Math.max(0, parseInt(recent.value, 10) || 0))
      });
      const save = async memorySettings => {
        await window.chatStorage.update(chat.id, { memorySettings });
        await this.loadMemoryLevels();
      };
      // on: the chat starts from the values it has now; off: back to the global ones
      own.onchange = () => this.perform(() => save(own.checked ? values() : null));
      cap.onchange = share.onchange = recent.onchange = () => this.perform(() => save(values()));
      // A cap past the main model's window: the conversation would fill the window before being compacted.
      const windowTokens = window.chatManager?.registryFor?.(window.chatManager.conversation)?.getCurrentMasterModel?.()?.contextLength || 0;
      const warning = $('memory-levels-warning');
      warning.hidden = !(windowTokens && tree.settings.cap > windowTokens * 0.85);
      warning.textContent = warning.hidden ? '' : t('memory.levelsCapWarning', { window: windowTokens.toLocaleString() });

      const count = level => tree.nodes.filter(n => n.level === level).length;
      const top = tree.nodes.reduce((a, n) => Math.max(a, n.level), 0);
      const parts = [t('memory.levelsTurns', { count: tree.turns })];
      // the tree's counts only mean something with the level memory on
      if (chat.memory_enabled) {
        parts.push(t('memory.levelsParagraphs', { count: count(1) }));
        if (top >= 2) parts.push(t('memory.levelsChapters', { count: count(2) }));
        for (let level = 3; level <= top; level++) parts.push(t('memory.levelsHigher', { level: level - 2, count: count(level) }));
      }
      if (chat.memory_enabled) parts.push(tree.view ? t('memory.levelsViewCompacted', { turn: tree.view.untilTurn }) : t('memory.levelsViewWhole'));
      else parts.push(tree.compaction ? t('memory.levelsClassic', { turn: tree.compaction.untilTurn }) : t('memory.levelsViewWhole'));
      $('memory-levels-status').textContent = parts.join(' · ');

      const list = $('memory-levels-tree');
      list.replaceChildren();
      if (!tree.nodes.length) {
        const empty = document.createElement('p');
        empty.className = 'memory-levels-empty';
        empty.textContent = chat.memory_enabled ? t('memory.levelsEmpty') : t('memory.levelsOff');
        list.append(empty);
        return;
      }
      const inView = new Set(tree.view?.nodeIds || []);
      const children = new Map();
      for (const node of tree.nodes) {
        const key = node.parentId || '';
        if (!children.has(key)) children.set(key, []);
        children.get(key).push(node);
      }
      for (const nodes of children.values()) nodes.sort((a, b) => (a.fromTurn || 0) - (b.fromTurn || 0));
      const render = node => {
        const item = document.createElement('details');
        item.className = `memory-level-node level-${Math.min(node.level, 4)}`;
        const head = document.createElement('summary');
        const name = document.createElement('span');
        name.className = 'memory-level-label';
        name.textContent = node.label;
        head.append(name);
        if (inView.has(node.id)) {
          const badge = document.createElement('span');
          badge.className = 'memory-level-badge';
          badge.textContent = t('memory.levelsInView');
          head.append(badge);
        }
        if (node.mechanical) {
          const badge = document.createElement('span');
          badge.className = 'memory-level-badge is-muted';
          badge.textContent = t('memory.levelsMechanical');
          head.append(badge);
        }
        const preview = document.createElement('span');
        preview.className = 'memory-level-preview';
        preview.textContent = node.content.replace(/\s+/g, ' ').slice(0, 140);
        head.append(preview);
        item.append(head);
        const body = document.createElement('div');
        body.className = 'memory-level-body';
        const text = document.createElement('p');
        text.textContent = node.content;
        body.append(text);
        if (node.facts.length) {
          const facts = document.createElement('ul');
          for (const fact of node.facts) { const li = document.createElement('li'); li.textContent = fact; facts.append(li); }
          body.append(facts);
        }
        const code = document.createElement('code');
        code.className = 'memory-level-code';
        code.textContent = node.id;
        body.append(code);
        item.append(body);
        // what it contains, drawn the first time it is opened
        item.addEventListener('toggle', () => {
          if (!item.open || item.dataset.filled) return;
          item.dataset.filled = '1';
          for (const child of children.get(node.id) || []) body.append(render(child));
        });
        return item;
      };
      for (const root of children.get('') || []) list.append(render(root));
    }

    openMemories(message) {
      return this.openChatMemories(message);
    }

    closeChatMemoryEditor() {
      this.editChatMemoryId = null;
      this.chatMemorySourceId = null;
      const form = $('chat-memory-form');
      if (form) form.hidden = true;
      const body = $('chat-memory-body');
      if (body) body.classList.remove('has-editor');
      document.querySelectorAll('#chat-memory-list .memory-item.is-editing').forEach(el => el.classList.remove('is-editing'));
    }

    resetChatMemoryForm() {
      this.closeChatMemoryEditor();
    }

    selectChatMemoryForEdit(item) {
      if (!item) return;
      this.editChatMemoryId = item.id;
      this.chatMemorySourceId = item.source_message_id;

      const form = $('chat-memory-form');
      if (form) form.hidden = false;
      const body = $('chat-memory-body');
      if (body) body.classList.add('has-editor');

      // Highlight active editing card
      document.querySelectorAll('#chat-memory-list .memory-item').forEach(el => el.classList.remove('is-editing'));
      const activeCard = document.querySelector(`[data-edit-chat-memory="${item.id}"]`)?.closest('.memory-item');
      if (activeCard) activeCard.classList.add('is-editing');

      const contentEl = $('chat-memory-content');
      if (contentEl) contentEl.value = item.content;
      const enabledEl = $('chat-memory-enabled-checkbox');
      if (enabledEl) enabledEl.checked = Boolean(item.enabled);
      const titleEl = $('chat-memory-editor-title');
      if (titleEl) titleEl.textContent = window.i18n ? window.i18n.t('memory.editChatTitle') : 'Modifica sintesi del turno';
      const hintEl = $('chat-memory-form-hint');
      if (hintEl) hintEl.textContent = window.i18n ? window.i18n.t('memory.chatFormHint') : 'Modifica la sintesi del turno per aggiornare il contesto del modello.';
      const badge = $('chat-memory-msg-badge');
      const badgeText = $('chat-memory-msg-id-text');
      if (badge && badgeText && item.source_message_id) {
        badgeText.textContent = `msg_id: ${item.source_message_id}`;
        badge.style.display = 'inline-flex';
      } else if (badge) {
        badge.style.display = 'none';
      }
      const saveBtn = $('btn-chat-memory-save');
      if (saveBtn) saveBtn.disabled = false;
      const errEl = $('chat-memory-form-error');
      if (errEl) errEl.textContent = '';
      contentEl?.focus();
    }

    async loadChatMemories() {
      const conversationId = window.chatManager.conversation?.id || null;
      if (!conversationId) return;
      const query = $('chat-memory-search')?.value || '';
      const items = await window.chatStorage.memories(conversationId, query, 'conversation');
      this.chatMemories = items;
      window.chatManager?.updateHeaderCounts?.();

      const emptyMsg = window.i18n ? window.i18n.t('memory.emptyChatTimeline') : 'Nessuna memoria per questa chat. Quando la memoria è attiva, ogni turno di risposta genera automaticamente una sintesi con ID messaggio.';
      const editLabel = window.i18n ? window.i18n.t('common.edit') : 'Modifica';
      const disableLabel = window.i18n ? window.i18n.t('common.disable') : 'Disattiva';
      const activeLabel = window.i18n ? window.i18n.t('common.active') : 'Attiva';

      const listEl = $('chat-memory-list');
      if (!listEl) return;

      // Render timeline without destructive delete button (preserves dialogue continuity)
      listEl.innerHTML = items.map((item, index) => {
        const isEditing = this.editChatMemoryId === item.id;
        const statusLabel = item.enabled 
          ? (window.i18n ? window.i18n.t('memory.statusActive') : 'Attiva') 
          : (window.i18n ? window.i18n.t('memory.statusDisabled') : 'Disattivata');
        const turnNumber = items.length - index;
        const turnLabel = window.i18n ? window.i18n.t('memory.turnNumber', { number: turnNumber }) : `Turno #${turnNumber}`;
        const msgIdTag = item.source_message_id 
          ? `<span class="memory-tag-msgid"><i class="fa-solid fa-link"></i> msg_id: ${item.source_message_id}</span>` 
          : '';

        return `
        <article class="memory-item ${item.enabled ? '' : 'memory-disabled'} ${isEditing ? 'is-editing' : ''}">
          <div class="memory-item-header">
            <span class="memory-tag-section"><i class="fa-solid fa-clock-rotate-left"></i> ${turnLabel}</span>
            ${msgIdTag}
            <span class="memory-item-meta">${statusLabel}</span>
          </div>
          <p>${window.escapeHtml(item.content)}</p>
          <div class="memory-item-actions">
            <button class="btn ${isEditing ? 'btn-primary' : ''}" data-edit-chat-memory="${item.id}"><i class="fa-solid fa-pen"></i> ${editLabel}</button>
            <button class="btn" data-toggle-chat-memory="${item.id}">${item.enabled ? disableLabel : activeLabel}</button>
          </div>
        </article>`;
      }).join('') || `<p class="conversation-empty">${emptyMsg}</p>`;

      if (!this.editChatMemoryId) {
        this.closeChatMemoryEditor();
      }

      listEl.querySelectorAll('[data-edit-chat-memory]').forEach(button => button.addEventListener('click', () => {
        const item = items.find(x => x.id === button.dataset.editChatMemory);
        if (!item) return;
        this.selectChatMemoryForEdit(item);
      }));

      listEl.querySelectorAll('[data-toggle-chat-memory]').forEach(button => button.addEventListener('click', () => this.perform(async () => {
        const item = items.find(x => x.id === button.dataset.toggleChatMemory);
        if (!item) return;
        await window.chatStorage.saveMemory({
          content: item.content,
          scope: 'conversation',
          section: item.section || 'turn_summary',
          conversationId: item.conversation_id,
          sourceMessageId: item.source_message_id,
          enabled: !item.enabled,
          pinned: true
        }, item.id);
        await this.loadChatMemories();
      })));
    }

    async saveChatMemory() {
      const saveBtn = $('btn-chat-memory-save');
      if (saveBtn) saveBtn.disabled = true;
      try {
        const convId = window.chatManager.conversation?.id || null;
        await window.chatStorage.saveMemory({
          content: $('chat-memory-content').value,
          scope: 'conversation',
          section: 'turn_summary',
          conversationId: convId,
          sourceMessageId: this.chatMemorySourceId,
          enabled: $('chat-memory-enabled-checkbox')?.checked ?? true,
          pinned: true
        }, this.editChatMemoryId);
        this.closeChatMemoryEditor();
        await this.loadChatMemories();
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    }
  }
  window.chatWorkspace = new ChatWorkspace();
})();
