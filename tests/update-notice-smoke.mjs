import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(
  new URL('../src/profile-switcher.js', import.meta.url),
  'utf8'
);

function createHarness({ focused = true, initialStatus = { status: 'noUpdate' } } = {}) {
  const elements = [];
  const windowHandlers = new Map();
  const copiedTexts = [];
  const openedUrls = [];
  let updateListener;
  let removedListener;

  class FakeClassList {
    constructor() {
      this.values = new Set();
    }

    add(...values) {
      values.forEach(value => this.values.add(value));
    }

    remove(...values) {
      values.forEach(value => this.values.delete(value));
    }
  }

  class FakeElement {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.classList = new FakeClassList();
      this.listeners = new Map();
      this.attributes = new Map();
      this.hidden = false;
      this.isConnected = false;
      this.open = false;
      if (tagName === 'dialog') {
        this.message = new FakeElement('p');
        this.copyButton = new FakeElement('button');
        this.openButton = new FakeElement('button');
      }
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    append(...children) {
      children.forEach(child => {
        child.parentElement = this;
        child.isConnected = this.isConnected;
        this.children.push(child);
      });
    }

    close() {
      if (!this.open) return;
      this.open = false;
      this.listeners.get('close')?.({ currentTarget: this, target: this });
    }

    click() {
      return this.listeners.get('click')?.({
        currentTarget: this,
        target: this
      });
    }

    querySelector(selector) {
      if (selector === '.profile-switcher-update-message') return this.message;
      if (selector === '[data-copy-project-url]') return this.copyButton;
      if (selector === '[data-open-project-url]') return this.openButton;
      return null;
    }

    remove() {
      this.isConnected = false;
      if (!this.parentElement) return;
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement = undefined;
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    showModal() {
      this.open = true;
      this.showCount = (this.showCount ?? 0) + 1;
    }
  }

  const head = new FakeElement('head');
  const body = new FakeElement('body');
  head.isConnected = true;
  body.isConnected = true;
  const documentObject = {
    activeElement: null,
    body,
    head,
    createElement(tagName) {
      const element = new FakeElement(tagName);
      elements.push(element);
      return element;
    },
    hasFocus: () => focused,
    querySelector: () => null
  };
  const autoUpdate = {
    getUpdateStatus(callback) {
      callback(initialStatus);
    },
    onWillInstallUpdateOnQuit: {
      addListener(listener) {
        updateListener = listener;
      },
      removeListener(listener) {
        removedListener = listener;
        if (updateListener === listener) updateListener = undefined;
      }
    }
  };
  const windowObject = {
    innerWidth: 1000,
    addEventListener(type, handler) {
      windowHandlers.set(type, handler);
    },
    removeEventListener() {},
    open() {}
  };
  const chromeObject = {
    autoUpdate,
    utilities: {
      copyToClipboard(text) {
        copiedTexts.push(text);
      }
    },
    tabs: {
      create({ url }) {
        openedUrls.push(url);
      }
    },
    runtimePrivate: {
      getUserProfiles(_includeGuest, callback) {
        callback([]);
      },
      openNamedProfile(_path, callback) {
        callback(true);
      }
    }
  };
  const context = vm.createContext({
    chrome: chromeObject,
    console: { info() {}, warn() {} },
    document: documentObject,
    Element: FakeElement,
    performance: { now: () => 1000 },
    ResizeObserver: class {
      disconnect() {}
      observe() {}
    },
    window: windowObject,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {}
  });
  vm.runInContext(source, context, { filename: 'profile-switcher.js' });

  function getNotice() {
    const dialog = elements.find(element => element.tagName === 'DIALOG');
    const warningButton = elements.find(element =>
      element.attributes.get('aria-label')?.startsWith('Vivaldi update ready'));
    return { dialog, warningButton, warningItem: warningButton?.parentElement };
  }

  return {
    context,
    copiedTexts,
    emitUpdate(version) {
      updateListener?.(version);
    },
    focus() {
      windowHandlers.get('focus')?.();
    },
    getNotice,
    listenerRemoved: () => Boolean(removedListener),
    openedUrls
  };
}

{
  const test = createHarness();
  assert.equal(test.getNotice().dialog, undefined,
    'no update does not create notice UI');
  test.context.showProfileSwitcherUpdateNoticeForTesting('8.4.test');
  const notice = test.getNotice();
  assert.equal(notice.dialog.open, true,
    'the console test helper opens the dialog without a staged update');
  assert.match(notice.dialog.message.textContent, /8\.4\.test/,
    'the console test helper displays its optional version');
}

{
  const test = createHarness({
    initialStatus: { status: 'willInstallUpdateOnQuit', version: '8.4.1' }
  });
  const notice = test.getNotice();
  assert.equal(notice.dialog.open, true,
    'an already staged update opens the dialog in the focused window');
  assert.match(notice.dialog.message.textContent, /8\.4\.1/,
    'the staged version is shown');
  assert.equal(notice.dialog.attributes.get('aria-labelledby'),
    'profile-switcher-update-title',
    'the dialog has an accessible name');
  notice.dialog.close();
  assert.equal(notice.warningItem.hidden, false,
    'closing the dialog reveals the warning icon');
  notice.warningButton.click();
  assert.equal(notice.dialog.open, true,
    'the warning icon reopens the dialog');
  assert.equal(notice.warningItem.hidden, true,
    'the warning icon hides while the dialog is open');
  await notice.dialog.copyButton.click();
  assert.deepEqual(test.copiedTexts,
    ['https://github.com/jvdweerthof/vivaldi-profile-switcher'],
    'copy link uses Vivaldi\'s clipboard API');
  notice.dialog.openButton.click();
  assert.deepEqual(test.openedUrls,
    ['https://github.com/jvdweerthof/vivaldi-profile-switcher'],
    'open GitHub creates a browser tab');
  test.context.stopProfileSwitcher();
  assert.equal(test.listenerRemoved(), true,
    'cleanup removes the updater listener');
  assert.equal(notice.dialog.isConnected, false,
    'cleanup removes the dialog');
  assert.equal(notice.warningItem.isConnected, false,
    'cleanup removes the warning icon');
  assert.equal(test.context.showProfileSwitcherUpdateNoticeForTesting, undefined,
    'cleanup removes the console test helper');
}

{
  const test = createHarness({
    focused: false,
    initialStatus: { status: 'willInstallUpdateOnQuit', version: '8.4.2' }
  });
  const notice = test.getNotice();
  assert.equal(notice.dialog.open, false,
    'a background window does not open a modal');
  assert.equal(notice.warningItem.hidden, false,
    'a background window still exposes the warning icon');
  test.focus();
  assert.equal(notice.dialog.open, true,
    'the pending dialog opens once when the window regains focus');
}

{
  const test = createHarness();
  test.emitUpdate('8.5.0');
  const notice = test.getNotice();
  assert.equal(notice.dialog.open, true,
    'the staged-update event opens the dialog');
  assert.match(notice.dialog.message.textContent, /8\.5\.0/,
    'the event version is shown');
}

process.stdout.write('Update notice smoke test passed.\n');
