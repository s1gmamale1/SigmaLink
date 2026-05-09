// V3-W14-001 — Element-picker overlay for the in-app browser.
//
// Injects a DevTools-style hover/click overlay into a target tab's
// `WebContentsView`. mousemove draws a blue outline + label; click freezes
// the selection and bubbles `outerHTML`, computed styles, and a screenshot
// to the renderer via the `design:capture` allowlisted event. The overlay
// nodes live inside a Shadow Root so they survive React re-renders and
// don't pollute the page stylesheet. Every `start()` returns a fresh
// `pickerToken` the dispatcher validates against.

import { randomUUID } from 'node:crypto';
import type { WebContentsView } from 'electron';

export interface PickerSession {
  token: string;
  workspaceId: string;
  tabId: string;
  pageUrl: string;
  capturedAt: number;
  selector: string;
  outerHTML: string;
  computedStyles: Record<string, string>;
  screenshotPng: string; // data: URL
}

export interface PickerEmit {
  capture: (s: PickerSession) => void;
  state: (active: boolean, workspaceId: string, tabId: string) => void;
}

interface ActiveTab {
  workspaceId: string;
  tabId: string;
  view: WebContentsView;
  token: string;
  navHandler: (() => void) | null;
  ipcHandler:
    | ((event: Electron.Event, channel: string, ...args: unknown[]) => void)
    | null;
}

const PICKER_IPC_CHANNEL = 'sigma-design-pick';

/** Self-contained script injected via `executeJavaScript`. Idempotent via the
 *  per-window `__sigmaPicker` flag. */
function buildPickerScript(): string {
  return `(() => {
    if (window.__sigmaPicker && window.__sigmaPicker.active) return;
    if (!window.__sigmaPicker) window.__sigmaPicker = {};
    const state = window.__sigmaPicker;
    state.active = true;
    state.frozen = false;
    const HOST_ID = 'sigma-design-overlay-root';
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
      document.documentElement.appendChild(host);
    }
    const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    shadow.innerHTML = [
      '<style>',
      ':host{all:initial}',
      '.sl-outline{position:fixed;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);box-shadow:0 0 0 1px rgba(255,255,255,0.6) inset;pointer-events:none;transition:all 80ms ease-out;border-radius:2px}',
      '.sl-label{position:fixed;background:#1e293b;color:#fff;font:600 11px/1.4 system-ui,sans-serif;padding:3px 6px;border-radius:3px;box-shadow:0 2px 8px rgba(0,0,0,0.3);pointer-events:none;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}',
      '.sl-banner{position:fixed;top:8px;left:50%;transform:translateX(-50%);background:rgba(30,41,59,0.95);color:#fff;font:600 12px/1.4 system-ui,sans-serif;padding:6px 12px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:none}',
      '</style>',
      '<div class="sl-outline" style="display:none"></div>',
      '<div class="sl-label" style="display:none"></div>',
      '<div class="sl-banner">Click an element to capture · Esc to cancel</div>',
    ].join('');
    const outline = shadow.querySelector('.sl-outline');
    const label = shadow.querySelector('.sl-label');
    let target = null;
    const buildSelector = (el) => {
      if (!el || el.nodeType !== 1) return '';
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      let cur = el;
      let depth = 0;
      while (cur && cur.nodeType === 1 && depth < 5) {
        let part = cur.tagName.toLowerCase();
        if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
        const cls = (cur.className && typeof cur.className === 'string')
          ? cur.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + CSS.escape(c)).join('')
          : '';
        if (cls) part += cls;
        const sib = cur.parentElement ? Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName) : [];
        if (sib.length > 1) part += ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')';
        parts.unshift(part);
        cur = cur.parentElement;
        depth++;
      }
      return parts.join(' > ');
    };
    const collectStyles = (el) => {
      const out = {};
      const cs = window.getComputedStyle(el);
      const KEYS = ['display','position','width','height','margin','padding','color','background-color','background','font-family','font-size','font-weight','line-height','border','border-radius','box-shadow','flex','grid-template-columns','grid-template-rows','gap','align-items','justify-content'];
      for (const k of KEYS) out[k] = cs.getPropertyValue(k);
      return out;
    };
    const draw = (el) => {
      const rect = el.getBoundingClientRect();
      outline.style.display = 'block';
      outline.style.left = rect.left + 'px';
      outline.style.top = rect.top + 'px';
      outline.style.width = rect.width + 'px';
      outline.style.height = rect.height + 'px';
      label.style.display = 'block';
      const tag = el.tagName.toLowerCase();
      const id = el.id ? '#' + el.id : '';
      const cls = (el.className && typeof el.className === 'string')
        ? '.' + el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3).join('.')
        : '';
      label.textContent = tag + id + cls + ' · ' + Math.round(rect.width) + '×' + Math.round(rect.height);
      const ly = rect.top - 24;
      label.style.left = Math.max(8, rect.left) + 'px';
      label.style.top = (ly < 8 ? rect.bottom + 4 : ly) + 'px';
    };
    const hover = (e) => {
      if (state.frozen) return;
      const path = e.composedPath ? e.composedPath() : [e.target];
      const el = path.find((n) => n && n.nodeType === 1 && n.id !== HOST_ID);
      if (!el) return;
      target = el;
      draw(el);
    };
    const click = (e) => {
      if (state.frozen) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      state.frozen = true;
      const el = target || e.target;
      try {
        const payload = {
          selector: buildSelector(el),
          outerHTML: (el.outerHTML || '').slice(0, 16384),
          computedStyles: collectStyles(el),
          pageUrl: location.href,
        };
        if (window.electronAPI && window.electronAPI.send) {
          window.electronAPI.send('${PICKER_IPC_CHANNEL}', payload);
        } else if (window.ipcRenderer && window.ipcRenderer.send) {
          window.ipcRenderer.send('${PICKER_IPC_CHANNEL}', payload);
        } else {
          // Sandboxed contents have no preload — fall through to title hop so
          // the main process can read it via did-finish-load handshake.
          document.title = '__SIGMA_PICK__:' + encodeURIComponent(JSON.stringify(payload));
        }
      } catch (err) {
        document.title = '__SIGMA_PICK_ERR__:' + (err && err.message ? err.message : String(err));
      }
    };
    const keydown = (e) => {
      if (e.key === 'Escape') {
        state.active = false;
        teardown();
      }
    };
    const teardown = () => {
      window.removeEventListener('mousemove', hover, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('keydown', keydown, true);
      const h = document.getElementById(HOST_ID);
      if (h && h.parentNode) h.parentNode.removeChild(h);
      state.active = false;
    };
    window.__sigmaPicker.teardown = teardown;
    window.addEventListener('mousemove', hover, true);
    window.addEventListener('click', click, true);
    window.addEventListener('keydown', keydown, true);
  })();`;
}

const TEARDOWN_SCRIPT = `(() => {
  if (window.__sigmaPicker && typeof window.__sigmaPicker.teardown === 'function') {
    window.__sigmaPicker.teardown();
  }
})();`;

/** Registry of active picker sessions keyed by tabId. One picker per tab;
 *  calling `start` on an already-active tab refreshes the token. */
export class DesignPickerRuntime {
  private active = new Map<string, ActiveTab>();
  private emit: PickerEmit;

  constructor(emit: PickerEmit) {
    this.emit = emit;
  }

  /** Start picker mode on a tab, returning a fresh token. */
  start(input: {
    workspaceId: string;
    tabId: string;
    view: WebContentsView;
  }): { pickerToken: string } {
    const existing = this.active.get(input.tabId);
    if (existing) this.detachHooks(existing);

    const token = randomUUID();
    const session: ActiveTab = {
      workspaceId: input.workspaceId,
      tabId: input.tabId,
      view: input.view,
      token,
      navHandler: null,
      ipcHandler: null,
    };
    this.active.set(input.tabId, session);
    this.attachHooks(session);
    void this.injectScript(session);
    this.emit.state(true, input.workspaceId, input.tabId);
    return { pickerToken: token };
  }

  /** Stop picker mode for a tab. */
  stop(tabId: string): void {
    const sess = this.active.get(tabId);
    if (!sess) return;
    this.detachHooks(sess);
    try {
      void sess.view.webContents.executeJavaScript(TEARDOWN_SCRIPT, true).catch(() => undefined);
    } catch {
      /* view may already be torn down */
    }
    this.active.delete(tabId);
    this.emit.state(false, sess.workspaceId, sess.tabId);
  }

  /** Stop picker mode on every tab — used during workspace teardown. */
  stopAll(): void {
    for (const id of Array.from(this.active.keys())) this.stop(id);
  }

  /** Lookup the most-recent token for a tab (`null` when picker is off). */
  getToken(tabId: string): string | null {
    return this.active.get(tabId)?.token ?? null;
  }

  /** Lookup the workspace that owns a picker token (for the dispatcher). */
  getSessionByToken(token: string): { workspaceId: string; tabId: string } | null {
    for (const sess of this.active.values()) {
      if (sess.token === token) {
        return { workspaceId: sess.workspaceId, tabId: sess.tabId };
      }
    }
    return null;
  }

  private async injectScript(sess: ActiveTab): Promise<void> {
    const wc = sess.view.webContents;
    if (wc.isDestroyed()) return;
    // Wait for did-finish-load if the page is still loading; safety timeout
    // unblocks at 250ms in case `isLoading` races with the actual finish.
    if (wc.isLoading()) {
      await new Promise<void>((resolve) => {
        const onceFinish = () => resolve();
        wc.once('did-finish-load', onceFinish);
        setTimeout(resolve, 250);
      });
    }
    try {
      await wc.executeJavaScript(buildPickerScript(), true);
    } catch {
      /* CSP / isolated worlds — non-fatal */
    }
  }

  private attachHooks(sess: ActiveTab): void {
    const wc = sess.view.webContents;
    // Re-inject on navigations so the picker survives SPA route changes.
    const navHandler = () => {
      void this.injectScript(sess);
    };
    wc.on('did-finish-load', navHandler);
    wc.on('did-navigate-in-page', navHandler);
    sess.navHandler = navHandler;

    const ipcHandler = (
      _event: Electron.Event,
      channel: string,
      ...args: unknown[]
    ) => {
      if (channel !== PICKER_IPC_CHANNEL) return;
      const payload = args[0];
      this.handleCapture(sess, payload);
    };
    // Cast through unknown — the WebContents `'ipc-message'` overload narrows
    // the callback shape but we need access to the channel + payload args here.
    (wc as unknown as { on: (event: string, cb: (...a: unknown[]) => void) => void }).on(
      'ipc-message',
      ipcHandler as unknown as (...a: unknown[]) => void,
    );
    sess.ipcHandler = ipcHandler;

    // Title-channel fallback for sandboxed contents that have no preload bridge.
    const titleHandler = (_e: unknown, title: string) => {
      if (typeof title !== 'string') return;
      const PICK = '__SIGMA_PICK__:';
      if (!title.startsWith(PICK)) return;
      try {
        const json = decodeURIComponent(title.slice(PICK.length));
        const payload = JSON.parse(json);
        this.handleCapture(sess, payload);
        // Restore a sane title so we don't leave the picker payload in the chrome.
        void wc.executeJavaScript('document.title = location.host || "Bridge Canvas";', true);
      } catch {
        /* best-effort */
      }
    };
    wc.on('page-title-updated', titleHandler);
  }

  private detachHooks(sess: ActiveTab): void {
    if (sess.view.webContents.isDestroyed()) return;
    const wc = sess.view.webContents;
    if (sess.navHandler) {
      try {
        wc.off('did-finish-load', sess.navHandler);
        wc.off('did-navigate-in-page', sess.navHandler);
      } catch {
        /* ignore */
      }
    }
    if (sess.ipcHandler) {
      try {
        (wc as unknown as { off: (event: string, cb: (...a: unknown[]) => void) => void }).off(
          'ipc-message',
          sess.ipcHandler as unknown as (...a: unknown[]) => void,
        );
      } catch {
        /* ignore */
      }
    }
    sess.navHandler = null;
    sess.ipcHandler = null;
  }

  private async handleCapture(sess: ActiveTab, raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    const selector = typeof r.selector === 'string' ? r.selector : '';
    const outerHTML = typeof r.outerHTML === 'string' ? r.outerHTML : '';
    const computedStyles =
      r.computedStyles && typeof r.computedStyles === 'object'
        ? (r.computedStyles as Record<string, string>)
        : {};
    const pageUrl = typeof r.pageUrl === 'string' ? r.pageUrl : '';
    let screenshotPng = '';
    try {
      const img = await sess.view.webContents.capturePage();
      // Down-scale heavy screenshots to keep IPC payloads small.
      const resized = img.resize({ width: 480 });
      screenshotPng = resized.toDataURL();
    } catch {
      /* screenshots are nice-to-have */
    }
    const session: PickerSession = {
      token: sess.token,
      workspaceId: sess.workspaceId,
      tabId: sess.tabId,
      pageUrl,
      capturedAt: Date.now(),
      selector,
      outerHTML,
      computedStyles,
      screenshotPng,
    };
    try {
      this.emit.capture(session);
    } catch {
      /* never throw from a webContents handler */
    }
  }
}
