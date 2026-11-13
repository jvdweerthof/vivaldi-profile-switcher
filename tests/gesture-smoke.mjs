import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(
  new URL('../src/profile-switcher.js', import.meta.url),
  'utf8'
);

function createHarness({
  maximize = false,
  windowType = 'normal',
  windowsAvailable = true,
  currentWindowId = 7,
  profileWindows = [
    { id: 7, state: 'normal', type: 'normal' },
    { id: 8, state: 'normal', type: 'normal' }
  ]
} = {}) {
  const handlers = new Map();
  const timers = new Map();
  const openedProfiles = [];
  const windowUpdates = [];
  let windowState = 'normal';
  let now = 1000;
  let nextTimer = 1;

  class FakeElement {
    closest() {
      return tabBar;
    }
  }

  const tabs = {
    getAttribute(name) {
      return name === 'aria-orientation' ? 'vertical' : null;
    }
  };
  const tabBar = { querySelector: () => tabs };
  const target = new FakeElement();
  const windowObject = {
    innerWidth: 1000,
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    removeEventListener() {}
  };
  const documentObject = {
    activeElement: null,
    head: { append() {} },
    createElement() {
      return { textContent: '', remove() {} };
    },
    querySelector() {
      return null;
    }
  };

  function setFakeTimeout(callback, delay) {
    const id = nextTimer;
    nextTimer += 1;
    timers.set(id, { callback, due: now + delay });
    return id;
  }

  function advance(milliseconds) {
    now += milliseconds;
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.due <= now)
      .sort((left, right) => left[1].due - right[1].due);
    due.forEach(([id, timer]) => {
      if (!timers.delete(id)) return;
      timer.callback();
    });
  }

  const chromeObject = {
      runtimePrivate: {
        getUserProfiles(_includeGuest, callback) {
          callback([
            { active: true, guest: false, name: 'Current', path: 'current' },
            { active: false, guest: false, name: 'Next', path: 'next' }
          ]);
        },
        openNamedProfile(path, callback) {
          openedProfiles.push(path);
          callback(true);
        }
      },
      ...(windowsAvailable ? {
        windows: {
          getCurrent(callback) {
            callback({ id: currentWindowId, state: windowState, type: windowType });
          },
          getAll(_query, callback) {
            callback(profileWindows);
          },
          update(id, updateInfo, callback) {
            windowUpdates.push({ id, updateInfo });
            if (updateInfo.state) windowState = updateInfo.state;
            callback({ id, ...updateInfo });
          }
        }
      } : {})
  };
  const context = vm.createContext({
    chrome: chromeObject,
    console: { info() {}, warn() {} },
    document: documentObject,
    Element: FakeElement,
    performance: { now: () => now },
    ResizeObserver: class {
      disconnect() {}
      observe() {}
    },
    window: windowObject,
    setTimeout: setFakeTimeout,
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval() {
      return 1;
    },
    clearInterval() {},
    requestAnimationFrame() {
      return 1;
    },
    cancelAnimationFrame() {}
  });
  const configuredSource = maximize ?
    source.replace('maximize: false', 'maximize: true') : source;
  vm.runInContext(configuredSource, context, { filename: 'profile-switcher.js' });

  function wheel(deltaX, delay = 10, altKey = false) {
    advance(delay);
    handlers.get('wheel')({
      altKey,
      button: 0,
      cancelable: true,
      ctrlKey: false,
      deltaMode: 0,
      deltaX,
      deltaY: 0,
      metaKey: false,
      preventDefault() {},
      shiftKey: false,
      stopImmediatePropagation() {},
      target
    });
  }

  return {
    advance,
    blur: () => handlers.get('blur')(),
    focus: () => handlers.get('focus')(),
    openedProfiles,
    optionWheel: (deltaX, delay = 10) => wheel(deltaX, delay, true),
    restoreWindow: () => {
      windowState = 'normal';
    },
    windowUpdates,
    wheel
  };
}

function createSingleWindowHarness() {
  return createHarness({
    profileWindows: [{ id: 7, state: 'normal', type: 'normal' }]
  });
}

{
  const test = createHarness({
    profileWindows: [
      {
        id: 7,
        state: 'normal',
        type: 'normal',
        tabs: [{ active: true, id: 70, vivExtData: '{}' }]
      },
      {
        id: 8,
        state: 'normal',
        type: 'normal',
        tabs: [{ active: true, id: 80, vivExtData: '{}' }]
      }
    ]
  });
  test.wheel(40);
  test.wheel(40);
  test.wheel(40);
  assert.equal(
    JSON.stringify(test.windowUpdates),
    JSON.stringify([{ id: 8, updateInfo: { focused: true } }]),
    'default navigation visits the next normal window before another profile'
  );
  assert.deepEqual(test.openedProfiles, []);
}

{
  const test = createHarness({
    currentWindowId: 8,
    profileWindows: [
      {
        id: 7,
        state: 'normal',
        type: 'normal',
        tabs: [{ active: true, id: 70, vivExtData: '{}' }]
      },
      {
        id: 8,
        state: 'normal',
        type: 'normal',
        tabs: [{ active: true, id: 80, vivExtData: '{}' }]
      }
    ]
  });
  test.wheel(40);
  test.wheel(40);
  test.wheel(40);
  assert.deepEqual(
    test.openedProfiles,
    ['next'],
    'default navigation switches profiles at the final local window'
  );
}

{
  const test = createHarness();
  test.optionWheel(40);
  test.optionWheel(40);
  test.optionWheel(40);
  assert.equal(
    JSON.stringify(test.windowUpdates),
    JSON.stringify([{ id: 8, updateInfo: { focused: true } }]),
    'modifier state does not change the sole window-first navigation behavior'
  );
  assert.deepEqual(
    test.openedProfiles,
    [],
    'the modifier swipe visits a window before switching profiles'
  );
}

{
  const test = createHarness({
    currentWindowId: 8,
    profileWindows: [
      { id: 7, state: 'normal', type: 'normal' },
      { id: 99, state: 'normal', type: 'popup' },
      { id: 8, state: 'normal', type: 'normal' }
    ]
  });
  test.wheel(-40);
  test.wheel(-40);
  test.wheel(-40);
  assert.equal(
    JSON.stringify(test.windowUpdates),
    JSON.stringify([{ id: 7, updateInfo: { focused: true } }]),
    'window switching excludes popup windows'
  );
}

{
  const test = createHarness({
    currentWindowId: 8,
    profileWindows: [
      { id: 7, state: 'normal', type: 'normal' },
      { id: 8, state: 'normal', type: 'normal' },
      { id: 9, state: 'normal', type: 'normal' }
    ]
  });
  test.wheel(-40);
  test.wheel(-40);
  test.wheel(-40);
  assert.equal(
    JSON.stringify(test.windowUpdates),
    JSON.stringify([{ id: 7, updateInfo: { focused: true } }]),
    'default navigation switches profile windows in either direction'
  );
}

{
  const test = createHarness({ currentWindowId: 8 });
  test.wheel(40);
  test.wheel(40);
  test.wheel(40);
  assert.equal(test.openedProfiles.length, 1, 'a boundary swipe switches profiles once');
  test.wheel(50);
  test.wheel(30);
  assert.equal(test.openedProfiles.length, 1, 'momentum cannot switch twice');
}

{
  const test = createHarness();
  test.focus();
  assert.deepEqual(
    test.windowUpdates,
    [],
    'window maximization is disabled by default'
  );
}

{
  const test = createHarness({ maximize: true });
  assert.equal(
    JSON.stringify(test.windowUpdates),
    JSON.stringify([{ id: 7, updateInfo: { state: 'maximized' } }]),
    'window maximization uses the maximum normal window state at startup'
  );
  test.focus();
  assert.equal(
    test.windowUpdates.length,
    1,
    'an already maximized window is not updated again'
  );
  test.restoreWindow();
  test.focus();
  assert.equal(
    test.windowUpdates.length,
    2,
    'a returning profile window is maximized again when focused'
  );
}

{
  assert.doesNotThrow(
    () => createHarness({ maximize: true, windowsAvailable: false }),
    'missing window APIs do not stop the profile switcher'
  );
}

{
  const test = createHarness({ maximize: true, windowType: 'popup' });
  test.focus();
  assert.deepEqual(
    test.windowUpdates,
    [],
    'popup windows are never maximized'
  );
}

{
  const test = createSingleWindowHarness();
  test.focus();
  test.wheel(30);
  test.wheel(25);
  test.wheel(27);
  test.wheel(29);
  test.wheel(20);
  test.wheel(15);
  test.wheel(10);
  assert.equal(
    test.openedProfiles.length,
    0,
    'a small rebound inside decaying momentum does not switch profiles'
  );
}

{
  const test = createSingleWindowHarness();
  test.focus();
  test.wheel(30);
  test.wheel(20);
  test.wheel(10);
  assert.equal(test.openedProfiles.length, 0, 'decaying focus momentum is ignored');
  test.advance(100);
  test.wheel(40);
  test.wheel(40);
  test.wheel(40);
  assert.equal(test.openedProfiles.length, 1, 'a gesture after momentum switches');
}

{
  const test = createSingleWindowHarness();
  test.focus();
  test.wheel(10);
  test.wheel(20);
  test.wheel(30);
  test.wheel(40);
  assert.equal(
    test.openedProfiles.length,
    1,
    'the complete distance of an accelerating swipe reaches the threshold'
  );
}

{
  const test = createSingleWindowHarness();
  test.focus();
  test.wheel(30);
  test.wheel(25);
  test.wheel(30);
  test.wheel(40);
  test.wheel(50);
  assert.equal(
    test.openedProfiles.length,
    1,
    'two sustained increases separate a gradual swipe from decaying momentum'
  );
}

{
  const sourceWindow = createSingleWindowHarness();
  sourceWindow.wheel(40);
  sourceWindow.wheel(40);
  sourceWindow.wheel(40);
  assert.equal(sourceWindow.openedProfiles.length, 1);
  sourceWindow.blur();

  const targetWindow = createSingleWindowHarness();
  targetWindow.focus();
  targetWindow.wheel(10);
  targetWindow.wheel(20);
  targetWindow.wheel(30);
  targetWindow.wheel(40);
  assert.equal(
    targetWindow.openedProfiles.length,
    1,
    'a newly focused profile accepts an immediate follow-up swipe'
  );
}

{
  const test = createSingleWindowHarness();
  test.focus();
  test.wheel(16);
  test.wheel(10);
  test.wheel(6);
  test.wheel(20);
  test.wheel(45);
  test.wheel(45);
  assert.equal(
    test.openedProfiles.length,
    1,
    'a rapidly accelerating same-direction swipe is recognized'
  );
}

{
  const test = createSingleWindowHarness();
  test.focus();
  test.wheel(16);
  test.wheel(-30);
  test.wheel(-40);
  test.wheel(-40);
  assert.equal(
    test.openedProfiles.length,
    1,
    'a rapid direction reversal is recognized'
  );
}

{
  const test = createSingleWindowHarness();
  test.focus();
  test.wheel(40, 50);
  test.wheel(35);
  test.wheel(35);
  assert.equal(
    test.openedProfiles.length,
    1,
    'a fresh first event after the initial momentum window is recognized'
  );
}

printfResult();

function printfResult() {
  process.stdout.write('Gesture smoke test passed.\n');
}
