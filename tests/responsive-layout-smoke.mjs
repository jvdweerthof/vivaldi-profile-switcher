import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(
  new URL('../src/profile-switcher.js', import.meta.url),
  'utf8'
);

function createHarness({ stripWidth = 104 } = {}) {
  const elements = [];
  const animationFrames = new Map();
  let nextAnimationFrame = 1;
  let refreshInterval;
  let resizeObserverCallback;
  let currentStripWidth = stripWidth;

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
      this.hidden = false;
      this.isConnected = false;
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

    closest(selector) {
      if (selector !== '.button-toolbar') return null;
      let element = this;
      while (element) {
        if (element.classList.contains('button-toolbar')) return element;
        element = element.parentElement;
      }
      return null;
    }

    contains(element) {
      if (element === this) return true;
      return this.children.some(child => child.contains(element));
    }

    focus() {}

    getBoundingClientRect() {
      if (this === strip) {
        return {
          bottom: 32,
          height: 32,
          left: 0,
          right: currentStripWidth,
          top: 0,
          width: currentStripWidth
        };
      }
      const item = this.parentElement === strip ? this :
        this.parentElement?.parentElement === strip ? this.parentElement : null;
      if (!item || item.hidden) {
        return { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 };
      }
      let left = 0;
      let top = 0;
      for (const sibling of strip.children.filter(child => !child.hidden)) {
        const width = 32;
        if (left > 0 && left + width > currentStripWidth) {
          left = 0;
          top += 32;
        }
        if (sibling === item) {
          return {
            bottom: top + 32,
            height: 32,
            left,
            right: left + width,
            top,
            width
          };
        }
        left += width;
      }
      return { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 };
    }

    matches(selector) {
      if (selector === 'button') return this.tagName === 'BUTTON';
      if (selector.startsWith('.')) {
        return this.classList.contains(selector.slice(1));
      }
      return false;
    }

    querySelector(selector) {
      if (selector === 'button') {
        return this.children.find(child => child.tagName === 'BUTTON') ?? null;
      }
      return null;
    }

    remove() {
      if (!this.parentElement) return;
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement = undefined;
      this.isConnected = false;
    }

    replaceChildren(...children) {
      this.children.forEach(child => {
        child.parentElement = undefined;
        child.isConnected = false;
      });
      this.children = [];
      this.append(...children);
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
  const profileWindows = [
    {
      id: 7,
      state: 'normal',
      type: 'normal',
      tabs: [
        { active: true, id: 70 },
        { active: false, id: 71 }
      ]
    },
    {
      id: 8,
      state: 'normal',
      type: 'normal',
      tabs: [{ active: true, id: 80 }]
    }
  ];
  const context = vm.createContext({
    chrome: {
      runtimePrivate: {
        getUserProfiles(_includeGuest, callback) {
          callback([
            { active: true, guest: false, name: 'Work', path: 'work' },
            { active: false, guest: false, name: 'Personal', path: 'personal' },
            { active: false, guest: false, name: 'Robot', path: 'robot' }
          ]);
        },
        openNamedProfile(_path, callback) {
          callback(true);
        }
      },
      windows: {
        getAll(_query, callback) {
          callback(profileWindows);
        },
        getCurrent(callback) {
          callback(profileWindows[0]);
        },
        update(_id, _updateInfo, callback) {
          callback?.();
        }
      }
    },
    console: { info() {}, warn() {} },
    document: documentObject,
    Element: FakeElement,
    getComputedStyle() {
      return { paddingLeft: '0', paddingRight: '0' };
    },
    performance: { now: () => 1000 },
    ResizeObserver: class {
      constructor(callback) {
        resizeObserverCallback = callback;
      }

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
    requestAnimationFrame(callback) {
      const id = nextAnimationFrame;
      nextAnimationFrame += 1;
      animationFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      animationFrames.delete(id);
    }
  });

  vm.runInContext(source, context, { filename: 'profile-switcher.js' });

  function flushLayout() {
    while (animationFrames.size) {
      const frames = [...animationFrames.entries()];
      animationFrames.clear();
      frames.forEach(([, callback]) => callback());
    }
  }

  return {
    anchorItem,
    flushLayout,
    profileItems: () => strip.children.filter(item =>
      item === anchorItem || item.classList.contains('profile-switcher-item')
    ),
    refresh() {
      refreshInterval();
      flushLayout();
    },
    resize(width) {
      currentStripWidth = width;
      resizeObserverCallback([{ contentRect: { width } }]);
      flushLayout();
    },
    windowDots: () => elements.find(element =>
      element.classList.contains('profile-switcher-window-dots') &&
      element.isConnected
    )
  };
}

const test = createHarness();
test.flushLayout();

const dots = test.windowDots();
const narrowProfiles = test.profileItems();
assert.ok(dots, 'multiple windows create position dots');
assert.equal(
  dots.children.length,
  2,
  'two normal browser windows render two dots'
);
assert.equal(dots.hidden, false, 'dots remain visible in a narrow profile strip');
assert.equal(
  dots.parentElement,
  test.anchorItem,
  'dots attach to the active profile instead of consuming a flex slot'
);
assert.equal(narrowProfiles.length, 3, 'all three profiles remain visible');
assert.ok(
  narrowProfiles.every(item => !item.hidden),
  'showing the dots does not collapse the profile list'
);
assert.ok(
  narrowProfiles.every(item =>
    !item.classList.contains('profile-switcher-compact-item') &&
    !item.classList.contains('profile-switcher-vertical-item')
  ),
  'profiles keep their canonical horizontal layout when they fit alone'
);
assert.equal(
  narrowProfiles[0].getBoundingClientRect().top,
  narrowProfiles[1].getBoundingClientRect().top,
  'profile avatars stay on one row while the dots remain visible'
);

test.resize(140);
assert.equal(dots.hidden, false, 'widening the strip keeps the dots visible');
assert.ok(
  test.profileItems().every(item => item.getBoundingClientRect().top === 0),
  'the restored dots do not disturb canonical profile order'
);

test.refresh();
assert.equal(dots.hidden, false, 'an idempotent refresh keeps restored dots visible');
assert.deepEqual(
  test.profileItems(),
  narrowProfiles,
  'an idempotent refresh preserves the profile DOM order'
);

process.stdout.write('Responsive layout smoke test passed.\n');
