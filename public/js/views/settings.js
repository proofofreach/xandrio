import { apiGet, apiSend, getCurrentUser, logout, getCurrentUserId, setCurrentUserId, getCurrentDeviceId, getCurrentDeviceName, resetSyncUser, isDefaultSyncUser } from '../api.js';
import { navigateTo } from '../router.js';
import { loadClientSettings, getClientSettings, getSkipInterval, getProgressDisplayMode, getDefaultSearchSources, setClientSetting } from '../client-settings.js';
import { loadLibrary } from './library.js';
import { initVoices, loadVoices, stopVoiceSample } from './voices.js';
import { readText, writeText } from '../util/storage.js';
import { escapeHTML, relativeTime } from '../util/format.js';
import { confirmSheet } from '../ui/confirm.js';
import { showToast } from '../ui/toast.js';
import { renderSegmentedControl } from '../ui/segmented.js';

let deps = {};
// --- Settings View ---
export function initSettings(options = {}) {
  deps = options;
  const settingsBtn = document.getElementById('settings-btn');
  const settingsBackBtn = document.getElementById('settings-back-btn');
  const settingsView = document.getElementById('settings-view');

  // Anna's Archive elements
  const annasStatus = document.getElementById('annas-status');
  const annasConnectedInfo = document.getElementById('annas-connected-info');
  const annasBaseUrl = document.getElementById('annas-base-url');
  const annasKeyUpdated = document.getElementById('annas-key-updated');
  const annasForm = document.getElementById('annas-form');
  const annasSecretKey = document.getElementById('annas-secret-key');
  const annasBaseUrlInput = document.getElementById('annas-base-url-input');
  const annasSaveBtn = document.getElementById('annas-save-btn');
  const annasCancelEditBtn = document.getElementById('annas-cancel-edit-btn');
  const annasEditBtn = document.getElementById('annas-edit-btn');
  const annasDisconnectBtn = document.getElementById('annas-disconnect-btn');
  const annasError = document.getElementById('annas-error');

  // Z-Library elements
  const zlibStatus = document.getElementById('zlib-status');
  const zlibConnectedInfo = document.getElementById('zlib-connected-info');
  const zlibDownloadsLeft = document.getElementById('zlib-downloads-left');
  const zlibForm = document.getElementById('zlib-form');
  const zlibEmail = document.getElementById('zlib-email');
  const zlibPassword = document.getElementById('zlib-password');
  const zlibConnectBtn = document.getElementById('zlib-connect-btn');
  const zlibCancelEditBtn = document.getElementById('zlib-cancel-edit-btn');
  const zlibEditBtn = document.getElementById('zlib-edit-btn');
  const zlibDisconnectBtn = document.getElementById('zlib-disconnect-btn');
  const zlibError = document.getElementById('zlib-error');

  // Sync elements
  const syncStatus = document.getElementById('sync-status');
  const syncProfileHint = document.getElementById('sync-profile-hint');
  const syncConnectedInfo = document.getElementById('sync-connected-info');
  const syncProfileName = document.getElementById('sync-profile-name');
  const syncDeviceList = document.getElementById('sync-device-list');
  const syncForm = document.getElementById('sync-form');
  const syncProfileInput = document.getElementById('sync-profile-input');
  const syncStartBtn = document.getElementById('sync-start-btn');
  const syncForgetBtn = document.getElementById('sync-forget-btn');
  const syncError = document.getElementById('sync-error');
  const syncSection = document.getElementById('sync-section');

  // Account elements (signed-in username/password sessions)
  const accountSection = document.getElementById('account-section');
  const accountDisplayName = document.getElementById('account-display-name');
  const accountUsernameHint = document.getElementById('account-username-hint');
  const accountRole = document.getElementById('account-role');
  const accountDeviceList = document.getElementById('account-device-list');
  const accountChangePasswordBtn = document.getElementById('account-change-password-btn');
  const accountLogoutBtn = document.getElementById('account-logout-btn');
  const accountPasswordForm = document.getElementById('account-password-form');
  const accountCurrentPassword = document.getElementById('account-current-password');
  const accountNewPassword = document.getElementById('account-new-password');
  const accountPasswordSaveBtn = document.getElementById('account-password-save-btn');
  const accountPasswordCancelBtn = document.getElementById('account-password-cancel-btn');
  const accountError = document.getElementById('account-error');
  const adminAccounts = document.getElementById('admin-accounts');
  const adminAccountList = document.getElementById('admin-account-list');
  const adminNewUsername = document.getElementById('admin-new-username');
  const adminNewPassword = document.getElementById('admin-new-password');
  const adminNewIsAdmin = document.getElementById('admin-new-is-admin');
  const adminAddAccountBtn = document.getElementById('admin-add-account-btn');
  const adminAccountsError = document.getElementById('admin-accounts-error');

  // Playback settings
  const skipIntervalControl = document.getElementById('skip-interval-control');
  const defaultSpeedLabel = document.getElementById('default-speed-label');
  const progressModeControl = document.getElementById('progress-mode-control');
  const defaultSearchSourcesControl = document.getElementById('default-search-sources');
  const defaultSearchSourcesError = document.getElementById('default-search-sources-error');
  const providerStatusList = document.getElementById('provider-status-list');
  const unverifiedSourcesEnabled = document.getElementById('unverified-sources-enabled');
  const unverifiedSourcesError = document.getElementById('unverified-sources-error');

  const operatorNoticeDialog = document.getElementById('operator-notice-dialog');
  const operatorNoticeAcknowledgement = document.getElementById('operator-notice-ack');
  const operatorNoticeContinue = document.getElementById('operator-notice-continue');
  const operatorNoticeError = document.getElementById('operator-notice-error');

  // Language
  const settingsLanguage = document.getElementById('settings-language');

  if (!settingsBtn) return;
  initVoices(deps);

  // Open/close settings. Data loads on every entry to the view (button tap,
  // deep link, or back/forward navigation) via the viewchange event.
  settingsBtn.addEventListener('click', () => navigateTo('settings'));

  document.addEventListener('xandrio:viewchange', (e) => {
    if (e.detail.view !== 'settings') return;
    checkAnnasStatus();
    checkZlibStatus();
    loadProviderStatus();
    loadAccountOrSync();
    renderClientSettings();
    loadPremiumPrepSetting();
    loadVoices();
    loadLanguagePref();
  });

  if (settingsBackBtn) {
    settingsBackBtn.addEventListener('click', () => {
      navigateTo('library');
      stopVoiceSample();
    });
  }

  const OPERATOR_NOTICE_KEY = 'xandrio_operator_notice_acknowledged_v1';
  function setOperatorNoticeError(message = '') {
    if (!operatorNoticeError) return;
    operatorNoticeError.textContent = message;
    operatorNoticeError.hidden = !message;
  }

  async function showOperatorNotice() {
    if (!operatorNoticeDialog) return;
    let acknowledged;
    let loadError = '';
    try {
      const policy = await apiGet('/api/legal/operator-policy');
      acknowledged = Boolean(policy.acknowledged);
      if (acknowledged) writeText(OPERATOR_NOTICE_KEY, policy.acknowledgedAt || new Date().toISOString());
    } catch (err) {
      // When the instance cannot be reached, retain the prior local decision
      // as an offline fallback. A server response always takes precedence.
      acknowledged = Boolean(readText(OPERATOR_NOTICE_KEY, ''));
      if (!acknowledged) loadError = 'This instance could not load the acknowledgement. Check the connection and try again.';
    }
    if (acknowledged) return;
    setOperatorNoticeError(loadError);
    operatorNoticeDialog.classList.add('active');
    operatorNoticeDialog.setAttribute('aria-hidden', 'false');
    setTimeout(() => operatorNoticeAcknowledgement?.focus(), 0);
  }

  operatorNoticeAcknowledgement?.addEventListener('change', () => {
    if (operatorNoticeContinue) operatorNoticeContinue.disabled = !operatorNoticeAcknowledgement.checked;
  });

  operatorNoticeContinue?.addEventListener('click', async () => {
    if (!operatorNoticeAcknowledgement?.checked) return;
    operatorNoticeContinue.disabled = true;
    operatorNoticeContinue.textContent = 'Saving...';
    setOperatorNoticeError('');
    try {
      const policy = await apiSend('PUT', '/api/legal/operator-policy', {
        acknowledged: true,
        unverifiedSourcesEnabled: false
      });
      writeText(OPERATOR_NOTICE_KEY, policy.acknowledgedAt || new Date().toISOString());
      operatorNoticeDialog?.classList.remove('active');
      operatorNoticeDialog?.setAttribute('aria-hidden', 'true');
      await loadProviderStatus();
      document.dispatchEvent(new CustomEvent('xandrio:search-sources-changed'));
    } catch (err) {
      setOperatorNoticeError(err.message || 'Could not save the acknowledgement. Check the connection and try again.');
    } finally {
      operatorNoticeContinue.disabled = !operatorNoticeAcknowledgement?.checked;
      operatorNoticeContinue.textContent = 'Continue';
    }
  });

  setTimeout(() => { showOperatorNotice(); }, 0);

  const PROVIDER_DISCLOSURES = {
    standardebooks: { detail: 'Provider-reported public-domain and licence information may still need review.' },
    gutenberg: { detail: 'Provider-reported public-domain information may still need review.' },
    annas: { detail: 'Optional key and upstream access; review provider terms before enabling.' },
    zlibrary: { detail: 'Search is available without an account; downloads require a connected account.' },
    internetarchive: { detail: 'Availability does not determine reuse or narration rights.' },
    opds: { detail: 'Connect your own OPDS catalog (Calibre-Web, Kavita, COPS). The operator selects the catalog and its access controls.' }
  };

  function providerEnablement(provider = {}) {
    if (provider.enabled === false) return { label: 'Disabled', className: 'is-attention' };
    if ((provider.requiresAcknowledgement || provider.requiresOperatorAcknowledgement) && provider.acknowledged === false) {
      return { label: 'Acknowledgement required', className: 'is-attention' };
    }
    if (provider.configured === false) return { label: 'Unconfigured', className: '' };
    return { label: 'Enabled', className: 'is-enabled' };
  }

  async function loadProviderStatus() {
    if (!providerStatusList) return;
    try {
      const data = await apiGet('/api/search/sources');
      const sources = data.sources || [];
      if (unverifiedSourcesEnabled) {
        unverifiedSourcesEnabled.checked = Boolean(data.operatorPolicy?.unverifiedSourcesEnabled);
      }
      providerStatusList.innerHTML = sources.map(provider => {
        const fallback = PROVIDER_DISCLOSURES[provider.id] || {};
        const enablement = providerEnablement(provider);
        const detail = provider.detail || fallback.detail || 'Review this provider before use.';
        return `<div class="provider-status-row">
          <div class="provider-status-copy">
            <strong>${escapeHTML(provider.label || provider.id)}</strong>
            <span>${escapeHTML(detail)}</span>
          </div>
          <span class="provider-status-badge ${enablement.className}">${escapeHTML(enablement.label)}</span>
        </div>`;
      }).join('') || '<p class="settings-hint">No providers are available on this instance.</p>';
    } catch {
      providerStatusList.innerHTML = '<p class="settings-hint">Provider status is unavailable. Check the server connection.</p>';
    }
  }

  unverifiedSourcesEnabled?.addEventListener('change', async () => {
    const enabled = unverifiedSourcesEnabled.checked;
    unverifiedSourcesEnabled.disabled = true;
    if (unverifiedSourcesError) unverifiedSourcesError.textContent = '';
    try {
      await apiSend('PUT', '/api/legal/operator-policy', {
        acknowledged: true,
        unverifiedSourcesEnabled: enabled
      });
      await loadProviderStatus();
      document.dispatchEvent(new CustomEvent('xandrio:search-sources-changed'));
    } catch (err) {
      unverifiedSourcesEnabled.checked = !enabled;
      if (unverifiedSourcesError) {
        unverifiedSourcesError.textContent = err.message || 'Could not update the instance source policy.';
      }
    } finally {
      unverifiedSourcesEnabled.disabled = false;
    }
  });

  // Anna's Archive — state tracking
  let annasIsEditing = false;
  let annasSavedBaseUrl = '';

  async function checkAnnasStatus() {
    try {
      const data = await apiGet('/api/annas/status');
      if (data.configured) {
        annasStatus.textContent = 'Connected';
        annasStatus.className = 'settings-status settings-status-ok';
        annasConnectedInfo.style.display = 'block';
        annasBaseUrl.textContent = data.baseUrl;
        if (annasKeyUpdated) {
          const detail = data.keySource === 'environment'
            ? ' · key set by ANNAS_SECRET_KEY'
            : data.updatedAt
              ? ` · local key updated ${new Date(data.updatedAt).toLocaleDateString()}`
              : ' · key stored locally';
          annasKeyUpdated.textContent = detail;
        }
        const environmentManaged = data.keySource === 'environment';
        annasEditBtn.disabled = environmentManaged;
        annasDisconnectBtn.disabled = environmentManaged;
        annasEditBtn.textContent = environmentManaged ? 'Managed by environment' : 'Replace local key';
        annasEditBtn.title = environmentManaged ? 'Update ANNAS_SECRET_KEY in the server environment and restart Xandrio.' : '';
        annasDisconnectBtn.title = environmentManaged ? 'Remove ANNAS_SECRET_KEY from the server environment and restart Xandrio.' : '';
        annasSavedBaseUrl = data.baseUrl;
        annasForm.style.display = 'none';
        annasCancelEditBtn.style.display = 'none';
        annasIsEditing = false;
      } else {
        annasStatus.textContent = 'Not configured';
        annasStatus.className = 'settings-status';
        annasConnectedInfo.style.display = 'none';
        annasForm.style.display = 'flex';
        annasEditBtn.disabled = false;
        annasDisconnectBtn.disabled = false;
        annasEditBtn.textContent = 'Replace local key';
        annasEditBtn.title = '';
        annasDisconnectBtn.title = '';
        annasCancelEditBtn.style.display = 'none';
        annasIsEditing = false;
      }
    } catch {
      annasStatus.textContent = 'Error';
      annasStatus.className = 'settings-status';
    }
  }

  // Anna's Archive — replace the locally stored key or edit its origin.
  annasEditBtn.addEventListener('click', () => {
    annasIsEditing = true;
    annasConnectedInfo.style.display = 'none';
    annasForm.style.display = 'flex';
    annasCancelEditBtn.style.display = 'inline-block';
    annasBaseUrlInput.value = annasSavedBaseUrl;
    annasSecretKey.value = '';
    annasSecretKey.placeholder = 'Replacement secret key';
    annasSaveBtn.textContent = 'Replace local key';
    annasError.style.display = 'none';
  });

  annasCancelEditBtn.addEventListener('click', () => {
    annasIsEditing = false;
    annasSecretKey.value = '';
    annasBaseUrlInput.value = '';
    annasSecretKey.placeholder = 'Secret Key';
    annasSaveBtn.textContent = 'Save';
    annasError.style.display = 'none';
    checkAnnasStatus();
  });

  // Anna's Archive — Disconnect (confirmation sheet)
  annasDisconnectBtn.addEventListener('click', async () => {
    const ok = await confirmSheet({
      title: "Disconnect Anna's Archive?",
      message: 'You can reconnect later with your secret key.',
      confirmLabel: 'Disconnect'
    });
    if (!ok) return;
    annasDisconnectBtn.disabled = true;
    try {
      const result = await apiSend('DELETE', '/api/annas/configure');
      await checkAnnasStatus();
      if (result.configured && result.keySource === 'environment') {
        annasError.textContent = 'Local settings were removed, but ANNAS_SECRET_KEY is still active. Replace or remove it in the server environment and restart Xandrio.';
        annasError.style.display = 'block';
      }
    } catch (err) {
      annasError.textContent = 'Failed to disconnect: ' + err.message;
      annasError.style.display = 'block';
    } finally {
      annasDisconnectBtn.disabled = false;
    }
  });

  // Anna's Archive — Save
  annasSaveBtn.addEventListener('click', async () => {
    const secretKey = annasSecretKey.value.trim();
    if (!secretKey) {
      annasError.textContent = 'Secret key is required';
      annasError.style.display = 'block';
      return;
    }

    annasSaveBtn.disabled = true;
    annasSaveBtn.textContent = 'Saving...';
    annasError.style.display = 'none';

    try {
      const data = await apiSend('POST', '/api/annas/configure', {
        secretKey,
        baseUrl: annasBaseUrlInput.value.trim() || 'annas-archive.gl'
      });

      if (data.success) {
        annasSecretKey.value = '';
        annasBaseUrlInput.value = '';
        annasSecretKey.placeholder = 'Secret Key';
        annasSaveBtn.textContent = 'Save';
        await checkAnnasStatus();
      } else {
        annasError.textContent = data.error || 'Save failed';
        annasError.style.display = 'block';
      }
    } catch (err) {
      annasError.textContent = 'Save failed: ' + err.message;
      annasError.style.display = 'block';
    } finally {
      annasSaveBtn.disabled = false;
      annasSaveBtn.textContent = annasIsEditing ? 'Replace local key' : 'Save';
    }
  });

  // Z-Library — state tracking
  let zlibIsEditing = false;

  function refreshSearchSourceAvailability() {
    document.dispatchEvent(new CustomEvent('xandrio:search-sources-changed'));
  }

  function renderZlibStatus(data = {}) {
    const state = data.state || 'unavailable';
    const isConnected = state === 'connected';
    const requiresReconnect = state === 'auth-expired' || state === 'unavailable';
    const statusCopy = {
      disconnected: 'Not connected',
      connected: 'Connected',
      'auth-expired': 'Reconnect required',
      unavailable: 'Temporarily unavailable'
    }[state] || 'Temporarily unavailable';

    zlibStatus.textContent = statusCopy;
    zlibStatus.className = isConnected ? 'settings-status settings-status-ok' : 'settings-status';
    zlibConnectedInfo.style.display = isConnected || requiresReconnect ? 'block' : 'none';
    zlibForm.style.display = isConnected ? 'none' : 'flex';
    zlibCancelEditBtn.style.display = zlibIsEditing ? 'inline-block' : 'none';
    zlibEditBtn.style.display = isConnected ? 'inline-block' : 'none';

    if (isConnected) {
      zlibDownloadsLeft.textContent = `${data.downloadsRemaining} downloads left today`;
    } else if (state === 'auth-expired') {
      zlibDownloadsLeft.textContent = 'Search still works. Reconnect to download or disconnect this saved session.';
    } else if (state === 'unavailable') {
      zlibDownloadsLeft.textContent = 'Search may still work. Reconnect or try later; you can also disconnect this saved session.';
    }

    if (!requiresReconnect) zlibIsEditing = false;
  }

  async function checkZlibStatus() {
    try {
      const data = await apiGet('/api/zlibrary/status');
      renderZlibStatus(data);
    } catch (err) {
      renderZlibStatus({ state: 'unavailable', message: err.message });
    }
  }

  // Z-Library — Edit
  zlibEditBtn.addEventListener('click', () => {
    zlibIsEditing = true;
    zlibConnectedInfo.style.display = 'none';
    zlibForm.style.display = 'flex';
    zlibCancelEditBtn.style.display = 'inline-block';
    zlibEmail.value = '';
    zlibPassword.value = '';
    zlibError.style.display = 'none';
  });

  zlibCancelEditBtn.addEventListener('click', () => {
    zlibIsEditing = false;
    zlibEmail.value = '';
    zlibPassword.value = '';
    zlibError.style.display = 'none';
    checkZlibStatus();
  });

  // Z-Library — Disconnect (confirmation sheet)
  zlibDisconnectBtn.addEventListener('click', async () => {
    const ok = await confirmSheet({
      title: 'Disconnect Z-Library?',
      message: 'You can reconnect later with your account.',
      confirmLabel: 'Disconnect'
    });
    if (!ok) return;
    zlibDisconnectBtn.disabled = true;
    try {
      await apiSend('DELETE', '/api/zlibrary/configure');
      zlibEmail.value = '';
      zlibPassword.value = '';
      zlibError.style.display = 'none';
      await checkZlibStatus();
      refreshSearchSourceAvailability();
    } catch (err) {
      zlibError.textContent = 'Failed to disconnect: ' + err.message;
      zlibError.style.display = 'block';
    } finally {
      zlibDisconnectBtn.disabled = false;
    }
  });

  // Z-Library — Connect
  zlibConnectBtn.addEventListener('click', async () => {
    const email = zlibEmail.value.trim();
    const password = zlibPassword.value;
    if (!email || !password) {
      zlibError.textContent = 'Email and password required';
      zlibError.style.display = 'block';
      return;
    }

    zlibConnectBtn.disabled = true;
    zlibConnectBtn.textContent = 'Connecting...';
    zlibError.style.display = 'none';

    try {
      const data = await apiSend('POST', '/api/zlibrary/configure', { email, password });

      if (data.state === 'connected' || data.success) {
        zlibEmail.value = '';
        zlibPassword.value = '';
        await checkZlibStatus();
        refreshSearchSourceAvailability();
      } else {
        zlibError.textContent = data.message || data.error || 'Connection failed';
        zlibError.style.display = 'block';
      }
    } catch (err) {
      zlibError.textContent = err.message || 'Connection failed';
      zlibError.style.display = 'block';
    } finally {
      zlibConnectBtn.disabled = false;
      zlibConnectBtn.textContent = 'Connect';
    }
  });

  function setSyncError(message) {
    if (!syncError) return;
    syncError.textContent = message || '';
    syncError.style.display = message ? 'block' : 'none';
  }

  function renderSyncProfile(profile) {
    const isSynced = Boolean(profile) && !isDefaultSyncUser(profile.id);
    if (syncStatus) {
      syncStatus.textContent = isSynced ? 'Synced' : 'Local';
      syncStatus.className = isSynced ? 'settings-status settings-status-ok' : 'settings-status';
    }
    if (syncProfileHint) {
      syncProfileHint.textContent = isSynced
        ? `${profile.devices?.length || 1} device${(profile.devices?.length || 1) === 1 ? '' : 's'} linked`
        : 'Not linked to a sync profile';
    }
    if (syncConnectedInfo) syncConnectedInfo.style.display = isSynced ? 'block' : 'none';
    if (syncForm) syncForm.style.display = isSynced ? 'none' : 'flex';
    if (syncProfileName) {
      const device = isSynced
        ? (profile.devices || []).find(item => item.id === getCurrentDeviceId())
        : null;
      syncProfileName.textContent = isSynced
        ? `${profile.name || 'My Library'} · ${device?.name || getCurrentDeviceName()}`
        : '';
    }
    if (syncDeviceList) {
      const devices = isSynced ? (profile.devices || []) : [];
      syncDeviceList.innerHTML = devices.map(device => `
        <div class="sync-device-row">
          <span>${escapeHTML(device.name || 'Device')}${device.id === getCurrentDeviceId() ? ' · this device' : ''}</span>
          <small>${escapeHTML(device.lastSeenAt ? relativeTime(device.lastSeenAt) : 'not seen yet')}</small>
        </div>
      `).join('');
    }
  }

  async function loadSyncStatus() {
    if (!syncStatus) return;
    setSyncError('');
    try {
      const data = await apiGet('/api/sync/profile');
      renderSyncProfile(data.profile);
    } catch (err) {
      syncStatus.textContent = 'Error';
      syncStatus.className = 'settings-status';
      console.warn('Sync status unavailable:', err);
      setSyncError(err.message || 'Sync status unavailable');
    }
  }

  syncStartBtn?.addEventListener('click', async () => {
    syncStartBtn.disabled = true;
    syncStartBtn.textContent = 'Starting...';
    setSyncError('');
    const previousUserId = getCurrentUserId();
    try {
      const data = await apiSend('POST', '/api/sync/profile', {
        name: syncProfileInput?.value.trim() || 'My Library',
        deviceId: getCurrentDeviceId(),
        deviceName: getCurrentDeviceName(),
        migrateFromUserId: previousUserId
      });
      if (!data.success) throw new Error(data.error || 'Could not start sync');
      setCurrentUserId(data.userId);
      await reloadClientSettingsForSyncUser();
      renderSyncProfile(data.profile);
      loadLibrary();
    } catch (err) {
      setSyncError(err.message);
    } finally {
      syncStartBtn.disabled = false;
      syncStartBtn.textContent = 'Create Profile';
    }
  });

  // ---- Account section (username/password sessions) ----

  function setAccountError(message) {
    if (!accountError) return;
    accountError.textContent = message || '';
    accountError.style.display = message ? 'block' : 'none';
  }

  async function loadAccountSection() {
    const user = getCurrentUser();
    if (!user) return;
    if (accountDisplayName) accountDisplayName.textContent = user.displayName || user.username;
    if (accountUsernameHint) accountUsernameHint.textContent = `@${user.username}`;
    if (accountRole) accountRole.textContent = user.role;
    setAccountError('');
    // Registering this device also returns the account's device list.
    try {
      const data = await apiSend('POST', '/api/sync/device', {
        deviceId: getCurrentDeviceId(),
        deviceName: getCurrentDeviceName()
      });
      const devices = data.profile?.devices || [];
      if (accountDeviceList) {
        accountDeviceList.innerHTML = devices.map(device => `
          <div class="sync-device-row">
            <span>${escapeHTML(device.name || 'Device')}${device.id === getCurrentDeviceId() ? ' · this device' : ''}</span>
            <small>${escapeHTML(device.lastSeenAt ? relativeTime(device.lastSeenAt) : 'not seen yet')}</small>
          </div>
        `).join('');
      }
    } catch (err) {
      console.warn('Device registration failed:', err);
    }
    if (adminAccounts) adminAccounts.style.display = user.role === 'admin' ? 'block' : 'none';
    if (user.role === 'admin') loadAdminAccounts();
  }

  // ---- Admin: manage accounts ----

  let adminResetTargetId = null;

  function setAdminAccountsError(message) {
    if (!adminAccountsError) return;
    adminAccountsError.textContent = message || '';
    adminAccountsError.style.display = message ? 'block' : 'none';
  }

  function adminAccountRowHTML(account) {
    const self = account.id === getCurrentUser()?.id;
    const label = `${escapeHTML(account.displayName || account.username)} <small>@${escapeHTML(account.username)} · ${escapeHTML(account.role)}${account.disabled ? ' · disabled' : ''}${self ? ' · you' : ''}</small>`;
    const actions = adminResetTargetId === account.id ? '' : `
      <span class="admin-account-actions">
        <button class="btn-ghost btn-sm" data-admin-reset="${escapeHTML(account.id)}">Reset password</button>
        ${self ? '' : `<button class="btn-ghost btn-sm${account.disabled ? '' : ' btn-ghost-danger'}" data-admin-toggle="${escapeHTML(account.id)}" data-admin-disabled="${account.disabled ? '0' : '1'}">${account.disabled ? 'Enable' : 'Disable'}</button>`}
      </span>`;
    const resetForm = adminResetTargetId === account.id ? `
      <div class="settings-form admin-reset-form">
        <input type="password" data-admin-reset-input="${escapeHTML(account.id)}" placeholder="New password (min 8 characters)" autocomplete="new-password" />
        <div class="settings-form-buttons">
          <button class="btn-primary btn-sm" data-admin-reset-save="${escapeHTML(account.id)}">Save</button>
          <button class="btn-ghost btn-sm" data-admin-reset-cancel>Cancel</button>
        </div>
      </div>` : '';
    return `
      <div class="sync-device-row admin-account-row">
        <span>${label}</span>
        ${actions}
      </div>
      ${resetForm}`;
  }

  let adminAccountsCache = [];

  async function loadAdminAccounts() {
    if (!adminAccountList) return;
    setAdminAccountsError('');
    try {
      const data = await apiGet('/api/accounts');
      adminAccountsCache = data.accounts || [];
      renderAdminAccounts();
    } catch (err) {
      setAdminAccountsError(err.message || 'Failed to load accounts');
    }
  }

  function renderAdminAccounts() {
    if (!adminAccountList) return;
    adminAccountList.innerHTML = adminAccountsCache.map(adminAccountRowHTML).join('');
  }

  adminAddAccountBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    setAdminAccountsError('');
    adminAddAccountBtn.disabled = true;
    try {
      await apiSend('POST', '/api/accounts', {
        username: adminNewUsername?.value.trim() || '',
        password: adminNewPassword?.value || '',
        role: adminNewIsAdmin?.checked ? 'admin' : 'member'
      });
      if (adminNewUsername) adminNewUsername.value = '';
      if (adminNewPassword) adminNewPassword.value = '';
      if (adminNewIsAdmin) adminNewIsAdmin.checked = false;
      showToast('Account created');
      await loadAdminAccounts();
    } catch (err) {
      setAdminAccountsError(err.message || 'Failed to create account');
    } finally {
      adminAddAccountBtn.disabled = false;
    }
  });

  adminAccountList?.addEventListener('click', async (e) => {
    const resetBtn = e.target.closest('[data-admin-reset]');
    if (resetBtn) {
      adminResetTargetId = resetBtn.dataset.adminReset;
      renderAdminAccounts();
      adminAccountList.querySelector(`[data-admin-reset-input="${CSS.escape(adminResetTargetId)}"]`)?.focus();
      return;
    }
    if (e.target.closest('[data-admin-reset-cancel]')) {
      adminResetTargetId = null;
      renderAdminAccounts();
      return;
    }
    const saveBtn = e.target.closest('[data-admin-reset-save]');
    if (saveBtn) {
      const id = saveBtn.dataset.adminResetSave;
      const input = adminAccountList.querySelector(`[data-admin-reset-input="${CSS.escape(id)}"]`);
      setAdminAccountsError('');
      try {
        await apiSend('POST', `/api/accounts/${encodeURIComponent(id)}/password`, { newPassword: input?.value || '' });
        adminResetTargetId = null;
        renderAdminAccounts();
        showToast('Password reset. That account was signed out everywhere.');
      } catch (err) {
        setAdminAccountsError(err.message || 'Failed to reset password');
      }
      return;
    }
    const toggleBtn = e.target.closest('[data-admin-toggle]');
    if (toggleBtn) {
      const id = toggleBtn.dataset.adminToggle;
      const disabled = toggleBtn.dataset.adminDisabled === '1';
      if (disabled) {
        const account = adminAccountsCache.find(item => item.id === id);
        const ok = await confirmSheet({
          title: 'Disable account',
          message: `Disable "${account?.username || id}"? They will be signed out everywhere and cannot sign in until re-enabled.`,
          confirmLabel: 'Disable'
        });
        if (!ok) return;
      }
      setAdminAccountsError('');
      try {
        await apiSend('POST', `/api/accounts/${encodeURIComponent(id)}/disabled`, { disabled });
        await loadAdminAccounts();
      } catch (err) {
        setAdminAccountsError(err.message || 'Failed to update account');
      }
    }
  });

  // Shows the account section for signed-in users, the legacy sync-profile
  // section for trusted-LAN instances without accounts.
  function loadAccountOrSync() {
    const user = getCurrentUser();
    if (accountSection) accountSection.style.display = user ? 'block' : 'none';
    if (syncSection) syncSection.style.display = user ? 'none' : 'block';
    if (user) loadAccountSection();
    else loadSyncStatus();
  }

  function toggleAccountPasswordForm(visible) {
    if (!accountPasswordForm) return;
    accountPasswordForm.style.display = visible ? 'flex' : 'none';
    setAccountError('');
    if (visible) accountCurrentPassword?.focus();
    else {
      if (accountCurrentPassword) accountCurrentPassword.value = '';
      if (accountNewPassword) accountNewPassword.value = '';
    }
  }

  accountChangePasswordBtn?.addEventListener('click', () => {
    toggleAccountPasswordForm(accountPasswordForm?.style.display === 'none');
  });
  accountPasswordCancelBtn?.addEventListener('click', () => toggleAccountPasswordForm(false));

  accountPasswordSaveBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    setAccountError('');
    accountPasswordSaveBtn.disabled = true;
    try {
      await apiSend('POST', '/api/auth/change-password', {
        currentPassword: accountCurrentPassword?.value || '',
        newPassword: accountNewPassword?.value || ''
      });
      toggleAccountPasswordForm(false);
      showToast('Password updated. Other devices were signed out.');
    } catch (err) {
      setAccountError(err.message || 'Failed to change password');
    } finally {
      accountPasswordSaveBtn.disabled = false;
    }
  });

  accountLogoutBtn?.addEventListener('click', async () => {
    try {
      await logout();
    } catch (err) {
      console.warn('Logout request failed:', err);
    }
    window.location.reload();
  });

  syncForgetBtn?.addEventListener('click', async () => {
    resetSyncUser();
    await reloadClientSettingsForSyncUser();
    if (syncCodeOutput) syncCodeOutput.style.display = 'none';
    renderSyncProfile(null);
    loadLibrary();
  });

  function renderClientSettings() {
    const settings = getClientSettings();
    renderSegmentedControl(skipIntervalControl, settings.skipIntervalSeconds || getSkipInterval(), 'skipInterval');
    renderSegmentedControl(progressModeControl, settings.progressDisplayMode || getProgressDisplayMode(), 'progressMode');
    const defaultSources = settings.defaultSearchSources || getDefaultSearchSources();
    defaultSearchSourcesControl?.querySelectorAll('input[type="checkbox"]').forEach(input => {
      input.checked = defaultSources.includes(input.value);
    });
    if (defaultSpeedLabel) {
      defaultSpeedLabel.textContent = settings.defaultSpeed ? `${Number(settings.defaultSpeed).toFixed(2)}x` : 'Not set';
    }
  }

  async function reloadClientSettingsForSyncUser() {
    await loadClientSettings({ force: true, preferLocal: false });
    deps.syncTimeDisplayModeFromClientSettings();
    deps.applySkipIntervalLabels();
    renderClientSettings();
  }

  skipIntervalControl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-skip-interval]');
    if (!btn) return;
    setClientSetting('skipIntervalSeconds', Number(btn.dataset.skipInterval));
    deps.applySkipIntervalLabels();
    renderClientSettings();
  });

  progressModeControl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-progress-mode]');
    if (!btn) return;
    setClientSetting('progressDisplayMode', btn.dataset.progressMode);
    deps.syncTimeDisplayModeFromClientSettings();
    renderClientSettings();
  });

  defaultSearchSourcesControl?.addEventListener('change', (e) => {
    const checked = [...defaultSearchSourcesControl.querySelectorAll('input:checked')].map(input => input.value);
    if (!checked.length) {
      e.target.checked = true;
      defaultSearchSourcesError.textContent = 'Keep at least one default source selected.';
      return;
    }
    defaultSearchSourcesError.textContent = '';
    setClientSetting('defaultSearchSources', checked);
    renderClientSettings();
  });

  // "Prepare premium audio in background" — server-side behavior toggle
  // (the prep scheduler runs on the server), default on.
  const premiumPrepControl = document.getElementById('premium-prep-control');

  async function loadPremiumPrepSetting() {
    if (!premiumPrepControl) return;
    try {
      const data = await apiGet('/api/premium-prep/settings');
      renderSegmentedControl(premiumPrepControl, data.enabled === false ? 'off' : 'on', 'premiumPrep');
    } catch (err) {
      console.warn('Premium prep setting load failed:', err);
    }
  }

  premiumPrepControl?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-premium-prep]');
    if (!btn) return;
    const enabled = btn.dataset.premiumPrep === 'on';
    renderSegmentedControl(premiumPrepControl, btn.dataset.premiumPrep, 'premiumPrep');
    try {
      await apiSend('POST', '/api/premium-prep/settings', { enabled });
    } catch (err) {
      console.error('Premium prep setting save failed:', err);
      await loadPremiumPrepSetting();
    }
  });

  document.addEventListener('xandrio:client-settings', (e) => {
    if (e.detail.key === 'progressDisplayMode' || e.detail.key === '*') deps.syncTimeDisplayModeFromClientSettings();
    if (e.detail.key === 'skipIntervalSeconds' || e.detail.key === '*') deps.applySkipIntervalLabels();
    renderClientSettings();
  });

  // Language preference
  function loadLanguagePref() {
    const saved = readText('xandrio_default_language', 'en');
    settingsLanguage.value = saved;
  }

  settingsLanguage.addEventListener('change', () => {
    writeText('xandrio_default_language', settingsLanguage.value);
    // Sync with search view language filter if it exists
    const searchLangFilter = document.getElementById('language-filter');
    if (searchLangFilter) searchLangFilter.value = settingsLanguage.value;
  });

}
