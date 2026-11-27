import { afterEach, describe, expect, test } from "bun:test";
import {
  SessionLockSurface,
  flush,
  getCapsLock,
  renderShell,
  requestActivationToken,
  useCapsLock,
  type Accessor,
  type NativeNode,
} from "@hewel/zgui";
import {
  launcherActivationAppId,
  mintActivationToken,
  notificationActivationAppId,
  sanitizeActivationAppId,
  withActivationToken,
} from "../src/activation.ts";

interface MockShell {
  readonly calls: Array<{ readonly appId?: string | undefined } | undefined>;
  nextResult: () => Promise<string | null>;
}

function installMockZguiShell(): {
  readonly shell: MockShell;
  readonly restore: () => void;
} {
  const host = globalThis as Record<string, unknown>;
  const prevShell = host.__zguiShell;
  const calls: Array<{ readonly appId?: string | undefined } | undefined> = [];
  const shell: MockShell = {
    calls,
    nextResult: () => Promise.resolve("wayland-token-1"),
  };
  host.__zguiShell = {
    requestActivationToken(options?: { readonly appId?: string | undefined }) {
      calls.push(options);
      return shell.nextResult();
    },
  };
  return {
    shell,
    restore() {
      if (prevShell === undefined) {
        delete host.__zguiShell;
      } else {
        host.__zguiShell = prevShell;
      }
    },
  };
}

function mountMockLockSurface<T>(
  initialCapsLock: boolean,
  setup: () => T,
): {
  readonly value: T;
  readonly setCapsLock: (next: boolean) => void;
  readonly subscriberCount: () => number;
  readonly dispose: () => void;
} {
  const host = globalThis as Record<string, unknown>;
  const prevShell = host.__zguiShell;
  let current = initialCapsLock;
  const subscribers = new Map<number, (next: boolean) => void>();
  let nextSubId = 1;
  let detachSurface: (() => void) | undefined;

  const regionBridge = {
    createElement: () => ({}),
    createTextNode: () => ({}),
    replaceText: () => {},
    isTextNode: () => false,
    insertNode: () => {},
    removeNode: () => {},
    getParentNode: () => null,
    getFirstChild: () => null,
    getNextSibling: () => null,
    setProperty: () => {},
    clearRoot: () => {},
    getReducedMotion: () => false,
    installStylesheet: () => {},
    removeStylesheet: () => {},
    getCapsLock: () => current,
    subscribeCapsLock(cb: (next: boolean) => void) {
      const id = nextSubId++;
      subscribers.set(id, cb);
      return () => {
        subscribers.delete(id);
      };
    },
  };

  let pendingAttach: (() => void) | undefined;
  host.__zguiShell = {
    getSessionGeneration: () => 1,
    installStylesheet: () => {},
    removeStylesheet: () => {},
    subscribeMonitors: () => () => {},
    requestActivationToken: () => Promise.resolve(null),
    openLock(
      _name: string,
      _output: string,
      attach: (root: NativeNode, bridge: unknown) => () => void,
    ) {
      pendingAttach = () => {
        detachSurface = attach({} as NativeNode, regionBridge);
      };
      return 1;
    },
    closeLock() {
      detachSurface?.();
      detachSurface = undefined;
    },
  };

  let captured!: T;
  const disposeShell = renderShell(() =>
    SessionLockSurface({
      name: "lock-dp-1",
      output: "dp-1",
      get children() {
        captured = setup();
        return null;
      },
    }),
  );
  flush();
  pendingAttach?.();
  pendingAttach = undefined;
  flush();

  let restored = false;
  const dispose = () => {
    if (restored) return;
    restored = true;
    disposeShell();
    detachSurface?.();
    detachSurface = undefined;
    if (prevShell === undefined) {
      delete host.__zguiShell;
    } else {
      host.__zguiShell = prevShell;
    }
  };

  return {
    get value() {
      return captured;
    },
    setCapsLock(next: boolean) {
      if (current === next) return;
      current = next;
      for (const cb of [...subscribers.values()]) {
        cb(next);
      }
    },
    subscriberCount: () => subscribers.size,
    dispose,
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("sanitizeActivationAppId", () => {
  test("strips trailing .desktop while preserving reverse-DNS case", () => {
    expect(sanitizeActivationAppId("org.gnome.Nautilus.desktop")).toBe("org.gnome.Nautilus");
    expect(sanitizeActivationAppId("org.mozilla.firefox.DESKTOP")).toBe("org.mozilla.firefox");
    expect(sanitizeActivationAppId("org.kde.dolphin")).toBe("org.kde.dolphin");
    expect(sanitizeActivationAppId("org.telegram.desktop.desktop")).toBe("org.telegram.desktop");
  });

  test("rejects nullish, empty, whitespace-only, and bare .desktop values", () => {
    expect(sanitizeActivationAppId(undefined)).toBeUndefined();
    expect(sanitizeActivationAppId(null)).toBeUndefined();
    expect(sanitizeActivationAppId("")).toBeUndefined();
    expect(sanitizeActivationAppId("   ")).toBeUndefined();
    expect(sanitizeActivationAppId(".desktop")).toBeUndefined();
    expect(sanitizeActivationAppId("   .desktop")).toBeUndefined();
  });

  test("rejects ASCII/C1 control characters, unpaired surrogates, and >256 UTF-8 byte appIds so requestActivationToken never throws TypeError", () => {
    const { restore } = installMockZguiShell();
    cleanups.push(restore);

    const exact256Ascii = "a".repeat(256);
    const over257Ascii = "a".repeat(257);
    const exact256TwoByte = "é".repeat(128); // 128 * 2 = 256 UTF-8 bytes
    const over258TwoByte = "é".repeat(129); // 129 * 2 = 258 UTF-8 bytes
    const exact256FourByte = "🚀".repeat(64); // 64 * 4 = 256 UTF-8 bytes
    const over260FourByte = "🚀".repeat(65); // 65 * 4 = 260 UTF-8 bytes

    expect(sanitizeActivationAppId(exact256Ascii)).toBe(exact256Ascii);
    expect(sanitizeActivationAppId(`${exact256Ascii}.desktop`)).toBe(exact256Ascii);
    expect(sanitizeActivationAppId(over257Ascii)).toBeUndefined();
    expect(sanitizeActivationAppId(`${over257Ascii}.desktop`)).toBeUndefined();

    expect(sanitizeActivationAppId(exact256TwoByte)).toBe(exact256TwoByte);
    expect(sanitizeActivationAppId(over258TwoByte)).toBeUndefined();
    expect(sanitizeActivationAppId(exact256FourByte)).toBe(exact256FourByte);
    expect(sanitizeActivationAppId(over260FourByte)).toBeUndefined();

    const hostileInputs = [
      "org.foo\x00bar",
      "org.foo\tbar",
      "org.foo\nbar.desktop",
      "org.foo\rbar",
      "org.foo\x1fbar",
      "org.foo\x7fbar",
      "org.foo\x80bar",
      "org.foo\x9fbar",
      "evil\n.desktop",
      "unpaired-\uD800-high",
      "unpaired-\uDC00-low",
      over257Ascii,
      over258TwoByte,
      over260FourByte,
      "",
      ".desktop",
    ];

    for (const candidate of hostileInputs) {
      const sanitized = sanitizeActivationAppId(candidate);
      expect(sanitized).toBeUndefined();
      // Passing sanitized result into real @hewel/zgui requestActivationToken must NEVER throw TypeError.
      expect(() => requestActivationToken(sanitized ? { appId: sanitized } : undefined)).not.toThrow();
    }

    for (const valid of [exact256Ascii, exact256TwoByte, exact256FourByte, "org.gnome.Nautilus.desktop"]) {
      const sanitized = sanitizeActivationAppId(valid);
      expect(sanitized).toBeDefined();
      expect(() => requestActivationToken({ appId: sanitized })).not.toThrow();
    }
  });
});

describe("domain appId selectors", () => {
  test("notificationActivationAppId uses only desktop_entry and never human-readable app_name", () => {
    expect(
      notificationActivationAppId({
        app_name: "Mozilla Firefox",
        desktop_entry: "org.mozilla.firefox.desktop",
      } as { readonly app_name: string; readonly desktop_entry?: string | null }),
    ).toBe("org.mozilla.firefox");

    expect(
      notificationActivationAppId({
        app_name: "Discord Desktop",
        desktop_entry: null,
      } as { readonly app_name: string; readonly desktop_entry?: string | null }),
    ).toBeUndefined();

    expect(
      notificationActivationAppId({
        app_name: "Signal",
      } as { readonly app_name: string; readonly desktop_entry?: string | null }),
    ).toBeUndefined();
  });

  test("launcherActivationAppId passes sanitized desktop entry only for desktop provider", () => {
    expect(
      launcherActivationAppId({
        provider_id: "desktop",
        item_id: "Alacritty.desktop",
      }),
    ).toBe("Alacritty");

    expect(
      launcherActivationAppId({
        provider_id: "plugin:window-switcher",
        item_id: "Alacritty.desktop",
      }),
    ).toBeUndefined();
  });
});

describe("mintActivationToken and withActivationToken", () => {
  test("invokes requestActivationToken synchronously on call before any await and normalizes null/empty/rejected tokens", async () => {
    const { shell, restore } = installMockZguiShell();
    cleanups.push(restore);

    let resolvePending!: (token: string | null) => void;
    shell.nextResult = () =>
      new Promise<string | null>(resolve => {
        resolvePending = resolve;
      });

    // Must call requestActivationToken synchronously BEFORE returning the Promise!
    const pending = mintActivationToken("org.gnome.TextEditor.desktop");
    expect(shell.calls).toEqual([{ appId: "org.gnome.TextEditor" }]);

    resolvePending("xdg-tok-42");
    const resolved = await pending;
    expect(resolved).toBe("xdg-tok-42");
    expect(withActivationToken({ id: "org.gnome.TextEditor.desktop" }, resolved)).toEqual({
      id: "org.gnome.TextEditor.desktop",
      activation_token: "xdg-tok-42",
    });

    // Omitted / tray call passes no options object and omits activation_token when null.
    shell.nextResult = () => Promise.resolve(null);
    const nullToken = await mintActivationToken();
    expect(shell.calls.at(-1)).toBeUndefined();
    expect(nullToken).toBeUndefined();
    const payloadWithoutToken = withActivationToken({ id: "discord" }, nullToken);
    expect(payloadWithoutToken).toEqual({ id: "discord" });
    expect("activation_token" in payloadWithoutToken).toBe(false);

    // Rejected promise degrades cleanly to undefined without throwing.
    shell.nextResult = () => Promise.reject(new Error("compositor disconnected"));
    expect(await mintActivationToken("firefox.desktop")).toBeUndefined();
  });
});

const solidPath = import.meta.resolve("solid-js", import.meta.resolve("@hewel/zgui"));
const isServerSolidBuild = /\/dist\/server(?:\.[^/]+)?\.js$/.test(solidPath);

describe("useCapsLock reactive lock-state tracking", () => {
  if (isServerSolidBuild) {
    test("replays pre-engaged Caps Lock state on SessionLockSurface mount, updates reactively on toggle, and unsubscribes on cleanup", async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--conditions=browser",
          "test",
          import.meta.path,
          "-t",
          "useCapsLock reactive lock-state tracking",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exit !== 0) throw new Error(`reactive useCapsLock test exited ${exit}\n${stdout}${stderr}`);
    });
  } else {
    test("replays pre-engaged Caps Lock state on SessionLockSurface mount, updates reactively on toggle, and unsubscribes on cleanup", () => {
      let initialSnapshot = false;
      const mounted = mountMockLockSurface<Accessor<boolean>>(true, () => {
        initialSnapshot = getCapsLock();
        return useCapsLock();
      });
      cleanups.push(mounted.dispose);

      // Pre-engaged Caps Lock prior to locking is immediately reflected on initial read.
      expect(initialSnapshot).toBe(true);
      expect(mounted.value()).toBe(true);
      expect(mounted.subscriberCount()).toBe(1);

      mounted.setCapsLock(false);
      expect(mounted.value()).toBe(false);

      mounted.setCapsLock(true);
      expect(mounted.value()).toBe(true);

      mounted.dispose();
      expect(mounted.subscriberCount()).toBe(0);
    });
  }
});
