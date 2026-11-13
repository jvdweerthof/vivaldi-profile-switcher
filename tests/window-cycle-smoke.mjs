import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(
  new URL('../src/profile-switcher.js', import.meta.url),
  'utf8'
);

function createHarness({
  currentWindowId = 7,
  profileWindows = [{ id: 7, state: 'normal', type: 'normal' }],
  windowsAvailable = true
} = {}) {
  const elements = [];
  let refreshInterval;

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

    contains(value) {
      return this.values.has(value);
    }
  }

  class FakeElement {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.classList = new FakeClassList();
      this.listeners = new Map();
      this.attributes = new Map();
      this.dataset = {};
      this.isConnected = false;
      this.hidden = false;
      this.textContent = '';
    }

    set className(value) {
      this.classList = new FakeClassList();
      String(value).split(/\s+/).filter(Boolean).forEach(name =>
        this.classList.add(name)
      );
    }

    get className() {
      return [...this.classList.values].join(' ');
    }

    get nextSibling() {
      if (!this.parentElement) return null;
      const index = this.parentElement.children.indexOf(this);
      return this.parentElement.children[index + 1] ?? null;
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    append(...children) {
      children.forEach(child => {
        child.remove();
        child.parentElement = this;
        child.isConnected = this.isConnected;
        this.children.push(child);
      });
    }

    before(element) {
      const parent = this.parentElement;
      if (!parent) return;
      element.remove();
      const index = parent.children.indexOf(this);
      element.parentElement = parent;
      element.isConnected = parent.isConnected;
      parent.children.splice(index, 0, element);
    }

    after(element) {
      const parent = this.parentElement;
      if (!parent) return;
      element.remove();
      const index = parent.children.indexOf(this);
      element.parentElement = parent;
      element.isConnected = parent.isConnected;
      parent.children.splice(index + 1, 0, element);
    }

    click() {
      this.listeners.get('click')?.({
        preventDefault() {},
        stopPropagation() {},
        currentTarget: this,
        target: this
      });
    }

    closest(selector) {
      if (selector !== '.button-toolbar') return null;
      let element = this;
      while (element) {
        if (element.classList.contains('button-toolbar')) return element;
        element = element.parentElement;
      }
      return null;
    }

    querySelector(selector) {
      if (selector === 'button') {
        return this.children.find(child => child.tagName === 'BUTTON') ?? null;
      }
      return null;
    }

    replaceChildren(...children) {
      this.children.forEach(child => {
        child.parentElement = undefined;
        child.isConnected = false;
      });
      this.children = [];
      this.append(...children);
    }

    remove() {
      if (!this.parentElement) return;
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement = undefined;
      this.isConnected = false;
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
  }

  const head = new FakeElement('head');
  head.isConnected = true;
  const strip = new FakeElement('div');
  strip.isConnected = true;
  const anchorItem = new FakeElement('div');
  anchorItem.classList.add('button-toolbar');
  const accountButton = new FakeElement('button');
  anchorItem.append(accountButton);
  strip.append(anchorItem);

  const documentObject = {
    activeElement: null,
    head,
    createElement(tagName) {
      const element = new FakeElement(tagName);
      elements.push(element);
      return element;
    },
    querySelector(selector) {
      return selector.includes('AccountButton') ? accountButton : null;
    }
  };
  const windows = windowsAvailable ? {
    getAll(query, callback) {
      assert.deepEqual([...query.windowTypes], ['normal']);
      callback(profileWindows);
    },
    getCurrent(callback) {
      callback(profileWindows.find(browserWindow =>
        browserWindow.id === currentWindowId
      ));
    },
    update(id, updateInfo, callback) {
      callback({ id, ...updateInfo });
    }
  } : undefined;
  const context = vm.createContext({
    chrome: {
      runtimePrivate: {
        getUserProfiles(_includeGuest, callback) {
          callback([
            { active: true, guest: false, name: 'Work', path: 'work' },
            { active: false, guest: false, name: 'Personal', path: 'personal' }
          ]);
        },
        openNamedProfile(_path, callback) {
          callback(true);
        }
      },
      ...(windows ? { windows } : {})
    },
    console: { info() {}, warn() {} },
    document: documentObject,
    Element: FakeElement,
    performance: { now: () => 1000 },
    ResizeObserver: class {
      disconnect() {}
      observe() {}
    },
    window: {
      innerWidth: 1000,
      addEventListener() {},
      removeEventListener() {}
    },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval(callback) {
      refreshInterval = callback;
      return 1;
    },
    clearInterval() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {}
  });

  vm.runInContext(source, context, { filename: 'profile-switcher.js' });

  return {
    anchorItem,
    refresh: () => refreshInterval(),
    windowDots: () => elements.find(element =>
      element.classList.contains('profile-switcher-window-dots') &&
      element.isConnected
    ),
    stop: () => context.stopProfileSwitcher()
  };
}

{
  const test = createHarness({
    profileWindows: [
      { id: 7, state: 'normal', type: 'normal' },
      { id: 8, state: 'normal', type: 'normal' }
    ]
  });
  const dots = test.windowDots();
  assert.ok(dots, 'multiple profile windows show position dots');
  assert.equal(dots.children.length, 2, 'each normal window receives one dot');
  assert.ok(
    dots.children[0].classList.contains('is-active'),
    'the current window uses the active native-theme state'
  );
  assert.equal(
    dots.children[0].attributes.get('aria-label'),
    'Window 1 (current)'
  );
}

{
  const profileWindows = [
    { id: 7, state: 'normal', type: 'normal' },
    { id: 8, state: 'normal', type: 'normal' }
  ];
  const test = createHarness({ profileWindows });
  assert.ok(test.windowDots(), 'two windows initially show window dots');
  profileWindows.pop();
  test.refresh();
  assert.equal(
    test.windowDots(),
    undefined,
    'closing the second normal window removes the window dots'
  );
}

{
  const test = createHarness();
  assert.equal(
    test.windowDots(),
    undefined,
    'a single profile window does not add redundant dots'
  );
}

{
  const test = createHarness({
    profileWindows: [
      { id: 7, state: 'normal', type: 'normal' },
      { id: 8, state: 'normal', type: 'normal' },
      { id: 99, state: 'normal', type: 'popup' }
    ]
  });
  const dots = test.windowDots();
  assert.ok(dots, 'multiple normal windows add window dots');
  assert.equal(dots.children.length, 2, 'popup windows do not receive dots');
  assert.equal(
    dots.attributes.get('aria-label'),
    'Windows in the current profile',
    'the dot group has an accessible label'
  );
  assert.ok(
    test.anchorItem.classList.contains('profile-switcher-has-window-dots'),
    'the active profile avatar receives the dot positioning class'
  );
}

{
  const profileWindows = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    state: 'normal',
    type: 'normal'
  }));
  const test = createHarness({ currentWindowId: 1, profileWindows });
  assert.equal(
    test.windowDots().children.length,
    8,
    'large window counts remain represented by shrinkable dots'
  );
}

assert.doesNotThrow(
  () => createHarness({ windowsAvailable: false }),
  'missing window APIs do not stop the profile switcher'
);

process.stdout.write('Window navigation smoke test passed.\n');
