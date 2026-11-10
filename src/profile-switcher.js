(() => {
  'use strict';

  // Vivaldi Profile Switcher
  // Loaded into Vivaldi's browser UI by the companion macOS installer.

  // Run in Vivaldi's browser UI, not a website's developer console.
  // Re-running replaces the previous handler. Call stopProfileSwitcher() to undo.
  // To preview the staged-update UI, open the window.html DevTools console and
  // run showProfileSwitcherUpdateNoticeForTesting(). An optional version may be
  // supplied, e.g. showProfileSwitcherUpdateNoticeForTesting('8.4.9999.1').
  globalThis.stopProfileSwitcher?.();
  globalThis.stopProfileSwipe?.(); // Compatibility with the original script name.
  const api = globalThis.vivaldi?.runtimePrivate ??
    globalThis.chrome?.runtimePrivate;
  const autoUpdate = globalThis.vivaldi?.autoUpdate ??
    globalThis.chrome?.autoUpdate;
  const utilitiesApi = globalThis.vivaldi?.utilities ??
    globalThis.chrome?.utilities;
  if (!api?.getUserProfiles || !api?.openNamedProfile) {
    throw new Error('Open the inspector for Vivaldi window.html first.');
  }

  const options = {
    // Optional exact profile names, e.g. ['Personal', 'Work'].
    // Empty means all non-guest profiles, in Vivaldi's order.
    order: [],
    // Keep profile windows at the maximum normal size (not full screen).
    maximize: false,
    threshold: 100,
    reverse: false
  };

  let total = 0;
  let lastEvent = 0;
  let locked = false;
  let busy = false;
  let stopped = false;
  let resetTimer;
  let horizontalGesture = false;
  let focusGuard = false;
  let guardedDelta = 0;
  let guardedRiseCount = 0;
  let guardedRiseTotal = 0;
  let guardedDeclined = false;
  let guardedTroughMagnitude = 0;
  let freshGestureCarry = 0;
  let maximizePending = false;
  let maximizeWarningShown = false;
  let updatePending = false;
  let updateDialogPresented = false;
  let pendingUpdateVersion = '';
  let updateDialog;
  let updateWarningItem;
  let copyFeedbackTimer;
  const gesturePause = 90;
  const initialMomentumWindow = 45;
  const projectUrl =
    'https://github.com/jvdweerthof/vivaldi-profile-switcher';
  const updateStagedEvent = autoUpdate?.onWillInstallUpdateOnQuit;

  function maximizeCurrentWindow() {
    if (!options.maximize || stopped || maximizePending) return;
    const windowsApi = globalThis.chrome?.windows;
    if (!windowsApi?.getCurrent || !windowsApi?.update) {
      if (!maximizeWarningShown) {
        maximizeWarningShown = true;
        console.warn('Profile switcher: window maximization is unavailable.');
      }
      return;
    }
    maximizePending = true;
    try {
      windowsApi.getCurrent(currentWindow => {
        if (stopped || !currentWindow || currentWindow.type !== 'normal' ||
            currentWindow.state === 'maximized') {
          maximizePending = false;
          return;
        }
        try {
          windowsApi.update(currentWindow.id, { state: 'maximized' }, () => {
            maximizePending = false;
          });
        } catch (error) {
          maximizePending = false;
          console.warn('Profile switcher: window maximization failed.', error);
        }
      });
    } catch (error) {
      maximizePending = false;
      console.warn('Profile switcher: window maximization failed.', error);
    }
  }

  function endGesture() {
    total = 0;
    locked = false;
    horizontalGesture = false;
    focusGuard = false;
    guardedDelta = 0;
    guardedRiseCount = 0;
    guardedRiseTotal = 0;
    guardedDeclined = false;
    guardedTroughMagnitude = 0;
    freshGestureCarry = 0;
  }

  function armGestureEnd() {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(endGesture, gesturePause);
  }

  function startsFreshGesture(delta, gap) {
    freshGestureCarry = 0;
    if (gap > gesturePause) return true;
    const magnitude = Math.abs(delta);
    const previousMagnitude = Math.abs(guardedDelta);
    const reversed = previousMagnitude >= .1 &&
      Math.sign(delta) !== Math.sign(guardedDelta) &&
      magnitude >= 4;
    if (previousMagnitude < 1) {
      return reversed || gap > initialMomentumWindow;
    }
    if (reversed) return true;
    const increased = Math.sign(delta) === Math.sign(guardedDelta) &&
      magnitude - previousMagnitude >= 2;
    if (!increased) {
      if (Math.sign(delta) === Math.sign(guardedDelta) &&
          magnitude < previousMagnitude) {
        guardedDeclined = true;
        guardedTroughMagnitude = guardedTroughMagnitude ?
          Math.min(guardedTroughMagnitude, magnitude) : magnitude;
      }
      guardedRiseCount = 0;
      guardedRiseTotal = 0;
      return false;
    }
    const accelerated =
      magnitude >= previousMagnitude * 1.35;
    if (guardedRiseCount === 0) {
      guardedRiseCount = 1;
      guardedRiseTotal = (guardedDeclined ? 0 : guardedDelta) + delta;
      if (accelerated) {
        freshGestureCarry = guardedDelta;
        return true;
      }
      return false;
    }
    guardedRiseCount += 1;
    const minimumRebound = Math.max(6, guardedTroughMagnitude * .25);
    const meaningfulRebound = !guardedDeclined ||
      magnitude - guardedTroughMagnitude >= minimumRebound;
    if (guardedRiseCount >= 2 && meaningfulRebound) {
      freshGestureCarry = guardedRiseTotal;
      return true;
    }
    guardedRiseTotal += delta;
    return false;
  }

  function orderedProfiles(profiles) {
    const list = profiles.filter(p => !p.guest);
    if (!options.order.length) return list;
    const ordered = options.order.map(name => list.find(p => p.name === name));
    if (ordered.some(p => !p)) {
      console.warn('Profile switcher: a configured profile name was not found.');
      return [];
    }
    return ordered;
  }

  function activateProfile(profile) {
    if (profile.active || busy || stopped) return;
    busy = true;
    api.openNamedProfile(profile.path, success => {
      busy = false;
      if (!success) console.warn('Profile switch failed:', profile.name);
    });
  }

  function setUpdateWarningVisible(visible) {
    if (!updateWarningItem) return;
    updateWarningItem.hidden = !visible;
    updateWarningItem.classList.remove(
      'profile-switcher-compact-item',
      'profile-switcher-vertical-item'
    );
    if (currentAnchorItem?.isConnected) placeItems(currentAnchorItem);
    scheduleLayout();
  }

  async function copyProjectUrl(button) {
    let copied = false;
    try {
      if (utilitiesApi?.copyToClipboard) {
        await utilitiesApi.copyToClipboard(projectUrl, {
          confidential: false
        });
        copied = true;
      } else if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(projectUrl);
        copied = true;
      }
    } catch (error) {
      console.warn('Profile switcher: copying the reinstall link failed.', error);
    }
    button.textContent = copied ? 'Copied' : 'Copy failed';
    clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = setTimeout(() => {
      if (!stopped && button.isConnected) button.textContent = 'Copy link';
    }, 1800);
  }

  function openProjectPage() {
    try {
      if (globalThis.chrome?.tabs?.create) {
        globalThis.chrome.tabs.create({ url: projectUrl });
      } else {
        window.open(projectUrl, '_blank', 'noopener');
      }
      updateDialog?.close();
    } catch (error) {
      console.warn('Profile switcher: opening the project page failed.', error);
    }
  }

  function ensureUpdateNotice() {
    if (updateDialog && updateWarningItem) return;

    updateDialog = document.createElement('dialog');
    updateDialog.className = 'profile-switcher-update-dialog';
    updateDialog.setAttribute('aria-labelledby',
      'profile-switcher-update-title');
    updateDialog.setAttribute('aria-describedby',
      'profile-switcher-update-message profile-switcher-update-detail');
    updateDialog.innerHTML = `
      <form method="dialog">
        <h2 id="profile-switcher-update-title">Vivaldi update ready</h2>
        <p id="profile-switcher-update-message"
          class="profile-switcher-update-message"></p>
        <p id="profile-switcher-update-detail"
          class="profile-switcher-update-detail">
          After Vivaldi restarts, open the Profile Switcher project and run
          <code>Install.command</code> again.
        </p>
        <footer>
          <button value="cancel">Later</button>
          <button type="button" data-copy-project-url>Copy link</button>
          <button type="button" class="primary" data-open-project-url>
            Open GitHub
          </button>
        </footer>
      </form>
    `;
    updateDialog.querySelector('[data-copy-project-url]')
      ?.addEventListener('click', event => copyProjectUrl(event.currentTarget));
    updateDialog.querySelector('[data-open-project-url]')
      ?.addEventListener('click', openProjectPage);
    updateDialog.addEventListener('close', () => {
      if (updatePending && !stopped) setUpdateWarningVisible(true);
    });
    document.body.append(updateDialog);

    updateWarningItem = document.createElement('div');
    updateWarningItem.hidden = true;
    updateWarningItem.className =
      'button-toolbar profile-switcher-update-warning';
    const warningButton = document.createElement('button');
    warningButton.type = 'button';
    warningButton.className = 'ToolbarButton-Button';
    warningButton.title = 'Vivaldi update ready — reinstall Profile Switcher after restarting';
    warningButton.setAttribute('aria-label',
      'Vivaldi update ready. Show Profile Switcher reinstall instructions.');
    warningButton.innerHTML = `
      <svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3 2.5 20h19L12 3Z"></path>
        <path d="M12 8.5v5M12 17h.01"></path>
      </svg>
    `;
    warningButton.addEventListener('click', showUpdateDialog);
    updateWarningItem.append(warningButton);
  }

  function showUpdateDialog() {
    if (!updatePending || stopped) return;
    ensureUpdateNotice();
    const message = updateDialog.querySelector(
      '.profile-switcher-update-message'
    );
    if (message) {
      const version = pendingUpdateVersion ?
        ` to version ${pendingUpdateVersion}` : '';
      message.textContent =
        `Vivaldi will update${version} when it restarts. ` +
        'The update will remove Profile Switcher.';
    }
    setUpdateWarningVisible(false);
    if (updateDialog.open) return;
    try {
      updateDialog.showModal();
      updateDialogPresented = true;
    } catch (error) {
      setUpdateWarningVisible(true);
      console.warn('Profile switcher: update notice could not be shown.', error);
    }
  }

  function onUpdateStaged(version = '') {
    const alreadyPending = updatePending;
    updatePending = true;
    pendingUpdateVersion = version || pendingUpdateVersion;
    ensureUpdateNotice();
    if (!alreadyPending && document.hasFocus?.() !== false) {
      showUpdateDialog();
    } else if (!updateDialog.open) {
      setUpdateWarningVisible(true);
    }
  }

  const style = document.createElement('style');
  style.textContent = `
    #tabs-tabbar-container {
      overscroll-behavior-x: contain;
    }
    .profile-switcher-item[hidden] {
      display: none !important;
    }
    .profile-switcher-update-warning[hidden] {
      display: none !important;
    }
    .profile-switcher-compact-item {
      flex: 0 0 auto !important;
      width: auto !important;
      min-width: 0 !important;
    }
    .profile-switcher-vertical-item {
      flex-basis: 100% !important;
      width: 100% !important;
      max-width: 100% !important;
      grid-column: 1 / -1 !important;
      box-sizing: border-box;
    }
    .profile-switcher-vertical-item > button {
      margin-inline: auto !important;
    }
    .profile-switcher-item .button-icon {
      transform: scale(.75); opacity: .55; pointer-events: none;
    }
    .profile-switcher-item button:hover .button-icon,
    .profile-switcher-item button:focus-visible .button-icon {
      opacity: 1;
    }
    .profile-switcher-update-warning .button-icon {
      width: 18px;
      height: 18px;
      fill: color-mix(in srgb, var(--colorHighlightBg) 22%, transparent);
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 1.8;
      vector-effect: non-scaling-stroke;
    }
    .profile-switcher-update-warning button:hover .button-icon,
    .profile-switcher-update-warning button:focus-visible .button-icon {
      fill: color-mix(in srgb, var(--colorHighlightBg) 38%, transparent);
    }
    .profile-switcher-update-dialog {
      box-sizing: border-box;
      width: min(420px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      margin: auto;
      padding: 0;
      overflow: auto;
      color: var(--colorFg);
      background: var(--colorBgLight, var(--colorBg));
      border: 1px solid var(--colorBorder);
      border-radius: var(--radius);
      box-shadow: 0 0 0 1px rgba(0, 0, 0, .1),
        0 3px 10px rgba(0, 0, 0, .3);
    }
    .profile-switcher-update-dialog::backdrop {
      background: rgba(0, 0, 0, .36);
    }
    .profile-switcher-update-dialog form {
      padding: 20px;
    }
    .profile-switcher-update-dialog h2 {
      margin: 0 0 10px;
      color: var(--colorFgIntense);
      font-size: 18px;
      font-weight: 600;
      line-height: 1.3;
    }
    .profile-switcher-update-dialog p {
      margin: 0;
      line-height: 1.45;
    }
    .profile-switcher-update-dialog .profile-switcher-update-detail {
      margin-top: 10px;
      color: var(--colorFgFaded);
    }
    .profile-switcher-update-dialog code {
      color: var(--colorFg);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: .92em;
    }
    .profile-switcher-update-dialog footer {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 20px;
    }
    .profile-switcher-update-dialog footer button {
      min-height: 30px;
      padding: 0 12px;
      border-radius: var(--radius);
    }
  `;
  document.head.append(style);
  let beforeItems = [];
  let afterItems = [];
  let profileItems = new Map();
  let currentProfiles = [];
  let currentAnchorItem;
  let layoutFrame;
  let observedStrip;
  let observedStripWidth;
  const itemProfiles = new WeakMap();
  const stripObserver = new ResizeObserver(entries => {
    const width = entries[0]?.contentRect.width;
    if (width === undefined ||
        Math.abs(width - (observedStripWidth ?? -1)) < .5) return;
    observedStripWidth = width;
    scheduleLayout();
  });

  function observeStrip(strip) {
    if (observedStrip === strip) return;
    stripObserver.disconnect();
    observedStrip = strip;
    observedStripWidth = undefined;
    if (strip) stripObserver.observe(strip);
  }

  function scheduleLayout() {
    if (stopped) return;
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(applyResponsiveLayout);
  }

  function itemForProfile(profile) {
    return profile.active ? currentAnchorItem : profileItems.get(profile.path);
  }

  function buttonsShareRow(items) {
    const buttons = items.map(item =>
      item.matches('button') ? item : item.querySelector('button')
    ).filter(Boolean);
    if (buttons.length < 2) return true;
    const stripRect = observedStrip?.getBoundingClientRect();
    const stripStyle = observedStrip && getComputedStyle(observedStrip);
    const leftEdge = stripRect && stripStyle ? stripRect.left +
      (parseFloat(stripStyle.paddingLeft) || 0) : -Infinity;
    const rightEdge = stripRect && stripStyle ? stripRect.right -
      (parseFloat(stripStyle.paddingRight) || 0) : Infinity;
    const firstTop = buttons[0].getBoundingClientRect().top;
    return buttons.every(button => {
      const rect = button.getBoundingClientRect();
      return Math.abs(rect.top - firstTop) < 2 &&
        rect.left >= leftEdge - 1 && rect.right <= rightEdge + 1;
    });
  }

  function adjacentProfiles(profiles, currentIndex) {
    if (profiles.length < 2) return profiles;
    const candidates = [
      profiles[(currentIndex - 1 + profiles.length) % profiles.length],
      profiles[currentIndex],
      profiles[(currentIndex + 1) % profiles.length]
    ];
    return candidates.filter((profile, index) =>
      candidates.findIndex(candidate => candidate.path === profile.path) === index
    );
  }

  function placeCompactItems(items, anchorItem) {
    const anchorIndex = items.indexOf(anchorItem);
    let cursor = anchorItem;
    for (let index = anchorIndex - 1; index >= 0; index -= 1) {
      cursor.before(items[index]);
      cursor = items[index];
    }
    cursor = anchorItem;
    for (let index = anchorIndex + 1; index < items.length; index += 1) {
      cursor.after(items[index]);
      cursor = items[index];
    }
  }

  function resetItemLayout(items) {
    items.forEach(item => {
      item.hidden = false;
      item.classList.remove(
        'profile-switcher-compact-item',
        'profile-switcher-vertical-item'
      );
    });
  }

  function applyResponsiveLayout() {
    layoutFrame = undefined;
    if (stopped) return;
    const anchorItem = currentAnchorItem;
    const profiles = currentProfiles;
    if (!anchorItem?.isConnected) return;
    const updateItems = updateWarningItem && !updateWarningItem.hidden ?
      [updateWarningItem] : [];
    updateWarningItem?.classList.remove(
      'profile-switcher-compact-item',
      'profile-switcher-vertical-item'
    );
    if (!profiles.length) {
      anchorItem.classList.remove(
        'profile-switcher-compact-item',
        'profile-switcher-vertical-item'
      );
      return;
    }
    const currentIndex = profiles.findIndex(profile => profile.active);
    if (currentIndex < 0) return;

    const allItems = profiles.map(itemForProfile).filter(Boolean);
    resetItemLayout(allItems);
    placeItems(anchorItem);
    // Reading the button positions flushes this temporary full layout before
    // the browser paints, so resizing does not flash between the three modes.
    if (buttonsShareRow([...allItems, ...updateItems])) return;

    const compactProfiles = adjacentProfiles(profiles, currentIndex);
    const compactItems = compactProfiles.map(itemForProfile).filter(Boolean);
    const visibleItems = new Set(compactItems);
    const activeButton = anchorItem.matches('button') ? anchorItem :
      anchorItem.querySelector('button');
    allItems.forEach(item => {
      const shouldHide = !visibleItems.has(item);
      if (shouldHide && item.contains(document.activeElement)) {
        activeButton?.focus();
      }
      item.hidden = shouldHide;
    });
    compactItems.forEach(item =>
      item.classList.add('profile-switcher-compact-item')
    );
    updateItems.forEach(item =>
      item.classList.add('profile-switcher-compact-item')
    );
    placeCompactItems(compactItems, anchorItem);
    if (buttonsShareRow([...compactItems, ...updateItems])) return;

    compactItems.forEach(item =>
      item.classList.add('profile-switcher-vertical-item')
    );
    updateItems.forEach(item =>
      item.classList.add('profile-switcher-vertical-item')
    );
  }

  function placeItems(anchorItem) {
    // Leave correctly positioned nodes alone: moving a pressed button can
    // interrupt the browser's mouse-down / mouse-up / click sequence.
    let next = anchorItem;
    [...beforeItems].reverse().forEach(item => {
      if (item.nextSibling !== next) next.before(item);
      next = item;
    });
    let previous = anchorItem;
    afterItems.forEach(item => {
      if (previous.nextSibling !== item) previous.after(item);
      previous = item;
    });
    if (updateWarningItem && previous.nextSibling !== updateWarningItem) {
      previous.after(updateWarningItem);
    }
  }

  let rendering = false;
  let signature = '';

  function refreshStrip() {
    if (stopped || rendering) return;
    const anchor = document.querySelector(
      '.tabbar-nested-buttons button[data-name="AccountButton"]'
    );
    const anchorItem = anchor?.closest('.button-toolbar') ?? anchor;
    if (!anchorItem?.parentElement) {
      observeStrip(undefined);
      currentAnchorItem?.classList.remove(
        'profile-switcher-compact-item',
        'profile-switcher-vertical-item'
      );
      currentAnchorItem = undefined;
      [...beforeItems, ...afterItems].forEach(item => item.remove());
      updateWarningItem?.remove();
      return;
    }
    const anchorChanged = currentAnchorItem !== anchorItem;
    const stripChanged = observedStrip !== anchorItem.parentElement;
    if (anchorChanged) {
      currentAnchorItem?.classList.remove(
        'profile-switcher-compact-item',
        'profile-switcher-vertical-item'
      );
    }
    currentAnchorItem = anchorItem;
    observeStrip(anchorItem.parentElement);
    if (anchorChanged || stripChanged) {
      placeItems(anchorItem);
      scheduleLayout();
    }

    rendering = true;
    api.getUserProfiles(false, profiles => {
      rendering = false;
      if (stopped) return;
      const list = orderedProfiles(profiles);
      const nextSignature = JSON.stringify(list.map(p =>
        [p.path, p.name, p.active, p.customAvatar, p.image]));
      if (signature === nextSignature) return;
      signature = nextSignature;
      currentProfiles = list;
      const currentIndex = list.findIndex(profile => profile.active);
      const beforeButtons = [];
      const afterButtons = [];
      const nextProfileItems = new Map();
      list.forEach((profile, index) => {
        // Keep Vivaldi's actual button in place for the active profile.
        if (profile.active) return;
        const item = document.createElement('div');
        item.className = 'button-toolbar button-circularimage button-cropimage profile-popup profile-switcher-item';
        const button = document.createElement('button');
        button.className = 'ToolbarButton-Button';
        button.draggable = false;
        button.type = 'button';
        button.setAttribute('aria-current', String(Boolean(profile.active)));
        const previous = list[(index - 1 + list.length) % list.length];
        const next = list[(index + 1) % list.length];
        button.title = `${profile.name}${profile.active ? ' (current)' : ''}` +
          `\nPrevious: ${previous.name} · Next: ${next.name}`;
        button.setAttribute('aria-label', profile.name);
        const avatar = document.createElement('img');
        avatar.src = profile.customAvatar || profile.image ||
          '/resources/contact-person.png';
        avatar.alt = '';
        avatar.className = 'button-icon';
        avatar.setAttribute('aria-hidden', 'true');
        avatar.addEventListener('error', () => {
          avatar.src = '/resources/contact-person.png';
        }, { once: true });
        avatar.addEventListener('load', scheduleLayout, { once: true });
        button.append(avatar);
        itemProfiles.set(item, profile);
        nextProfileItems.set(profile.path, item);
        item.append(button);
        (index < currentIndex ? beforeButtons : afterButtons).push(item);
      });
      [...beforeItems, ...afterItems].forEach(item => item.remove());
      beforeItems = beforeButtons;
      afterItems = afterButtons;
      profileItems = nextProfileItems;
      // Direct siblings preserve Vivaldi's toolbar-specific CSS selectors.
      if (anchorItem.isConnected) {
        placeItems(anchorItem);
        scheduleLayout();
      }
    });
  }

  function onProfileClick(event) {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const item = event.target.closest('.profile-switcher-item');
    const profile = item && itemProfiles.get(item);
    if (!profile) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    activateProfile(profile);
  }

  function switchProfile(direction) {
    if (busy || stopped) return;
    busy = true;
    api.getUserProfiles(false, profiles => {
      if (stopped) return;
      const list = orderedProfiles(profiles);
      const current = list.findIndex(p => p.active);
      if (list.length < 2 || current < 0) {
        busy = false;
        return;
      }
      const target = list[(current + direction + list.length) % list.length];
      api.openNamedProfile(target.path, success => {
        busy = false;
        if (!success) console.warn('Profile switch failed:', target.name);
      });
    });
  }

  function onWheel(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (!(event.target instanceof Element)) return;
    const bar = event.target.closest('#tabs-tabbar-container');
    if (!bar) return;
    const tabs = bar.querySelector('#tabs-container');
    if (tabs?.getAttribute('aria-orientation') !== 'vertical') return;
    const now = performance.now();
    const gap = now - lastEvent;
    if (gap > gesturePause) {
      total = 0;
      locked = false;
      horizontalGesture = false;
    }
    // Claim even tiny horizontal movements before checking the switch threshold.
    // Once claimed, consume the gesture's diagonal/momentum tail as well.
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      horizontalGesture = true;
    }
    if (!horizontalGesture) return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    const delta = event.deltaX * (event.deltaMode === 1 ? 16 :
      event.deltaMode === 2 ? window.innerWidth : 1);
    if (focusGuard) {
      if (!startsFreshGesture(delta, gap)) {
        guardedDelta = delta;
        lastEvent = now;
        armGestureEnd();
        return;
      }
      total = freshGestureCarry;
      locked = false;
      focusGuard = false;
      guardedDelta = 0;
      guardedRiseCount = 0;
      guardedRiseTotal = 0;
      guardedDeclined = false;
      guardedTroughMagnitude = 0;
      freshGestureCarry = 0;
    }
    lastEvent = now;
    armGestureEnd();
    if (locked || busy) return;
    if (total && Math.sign(total) !== Math.sign(delta)) total = 0;
    total += delta;
    if (Math.abs(total) < options.threshold) return;
    locked = true;
    const direction = Math.sign(total) * (options.reverse ? -1 : 1);
    total = 0;
    switchProfile(direction);
  }

  function onBlur() {
    clearTimeout(resetTimer);
    total = 0;
    locked = true;
    horizontalGesture = false;
    focusGuard = false;
    guardedDelta = 0;
    guardedRiseCount = 0;
    guardedRiseTotal = 0;
    guardedDeclined = false;
    guardedTroughMagnitude = 0;
    freshGestureCarry = 0;
  }

  function onFocus() {
    maximizeCurrentWindow();
    refreshStrip();
    if (updatePending && !updateDialogPresented) showUpdateDialog();
    clearTimeout(resetTimer);
    total = 0;
    locked = false;
    horizontalGesture = false;
    focusGuard = true;
    guardedDelta = 0;
    guardedRiseCount = 0;
    guardedRiseTotal = 0;
    guardedDeclined = false;
    guardedTroughMagnitude = 0;
    freshGestureCarry = 0;
    lastEvent = performance.now();
    armGestureEnd();
  }

  window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  window.addEventListener('click', onProfileClick, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  // Follow the native profile button if the toolbar is reconstructed or moved.
  const stripTimer = setInterval(refreshStrip, 1500);
  maximizeCurrentWindow();
  refreshStrip();
  try {
    updateStagedEvent?.addListener(onUpdateStaged);
    autoUpdate?.getUpdateStatus?.(status => {
      if (status?.status === 'willInstallUpdateOnQuit') {
        onUpdateStaged(status.version);
      }
    });
  } catch (error) {
    console.warn('Profile switcher: update status is unavailable.', error);
  }
  globalThis.showProfileSwitcherUpdateNoticeForTesting =
    (version = '99.0.0.0') => {
      if (stopped) return;
      updatePending = false;
      updateDialogPresented = false;
      if (updateDialog?.open) updateDialog.close();
      pendingUpdateVersion = String(version);
      updatePending = true;
      showUpdateDialog();
    };
  globalThis.stopProfileSwitcher = () => {
    stopped = true;
    clearTimeout(resetTimer);
    clearTimeout(copyFeedbackTimer);
    clearInterval(stripTimer);
    cancelAnimationFrame(layoutFrame);
    stripObserver.disconnect();
    updateStagedEvent?.removeListener(onUpdateStaged);
    currentAnchorItem?.classList.remove(
      'profile-switcher-compact-item',
      'profile-switcher-vertical-item'
    );
    currentProfiles = [];
    profileItems.clear();
    currentAnchorItem = undefined;
    [...beforeItems, ...afterItems].forEach(item => item.remove());
    updateWarningItem?.remove();
    updateDialog?.remove();
    updatePending = false;
    updateDialogPresented = false;
    style.remove();
    window.removeEventListener('wheel', onWheel, true);
    window.removeEventListener('click', onProfileClick, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
    delete globalThis.showProfileSwitcherUpdateNoticeForTesting;
    delete globalThis.stopProfileSwitcher;
    console.info('Profile switcher disabled.');
  };
  console.info('Profile switcher enabled over the vertical tab bar.');
})();
