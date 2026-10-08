"""Browser-only regression checks; no server pairing or native actions are performed.

Run with Vite on port 1420 and a Python environment containing Playwright.
"""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright, expect


def main():
    output = Path(os.environ.get("TEMP", ".")) / "homeplace-ui-checks"
    output.mkdir(exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            context = browser.new_context(viewport={"width": 1200, "height": 800}, locale="en-US", reduced_motion="reduce")
            context.add_init_script("localStorage.setItem('homeplace-language', 'en');")
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto("http://127.0.0.1:1420")
            page.wait_for_load_state("networkidle")
            print("Buttons:", page.get_by_role("button").all_text_contents())
            page.screenshot(path=str(output / "main-before.png"), full_page=True)
            sidebar = page.locator(".app-sidebar")
            sidebar.hover()
            expect(page.locator(".desktop-shell")).to_have_class("desktop-shell sidebar-expanded")
            first_nav = sidebar.locator("nav button").first
            first_nav.focus()
            page.mouse.move(700, 400)
            expect(page.locator(".desktop-shell")).to_have_class("desktop-shell sidebar-expanded")
            page.get_by_role("button", name="Change theme", exact=True).focus()
            expect(page.locator(".desktop-shell")).to_have_class("desktop-shell")

            maximize = page.get_by_role("button", name="Maximize window", exact=True)
            maximize.focus()
            maximize.press("ArrowDown")
            menu = page.get_by_role("menu", name="Snap layouts")
            expect(menu).to_be_visible()
            expect(menu.get_by_role("menuitem").first).to_be_focused()
            page.keyboard.press("End")
            expect(menu.get_by_role("menuitem").last).to_be_focused()
            page.keyboard.press("ArrowDown")
            expect(menu.get_by_role("menuitem").first).to_be_focused()
            page.keyboard.press("Escape")
            expect(menu).to_have_count(0)
            expect(maximize).to_be_focused()
            maximize.hover()
            expect(menu).to_be_visible()
            page.mouse.move(700, 400)
            expect(menu).to_have_count(0)
            maximize.press("ArrowDown")
            expect(menu).to_be_visible()
            page.get_by_role("heading", name="Overview", exact=True).click()
            expect(menu).to_have_count(0)
            maximize.press("ArrowDown")
            expect(menu).to_be_visible()
            page.evaluate("window.dispatchEvent(new Event('blur'))")
            expect(menu).to_have_count(0)
            page.get_by_role("button", name="RU", exact=True).click()
            russian_maximize = page.get_by_role("button", name="Развернуть окно", exact=True)
            russian_maximize.press("ArrowDown")
            expect(page.get_by_role("menu", name="Раскладка окон")).to_be_visible()
            page.keyboard.press("Escape")
            page.get_by_role("button", name="EN", exact=True).click()

            page.screenshot(path=str(output / "main-after.png"), full_page=True)
            assert not errors, errors
            print("PASS: sidebar focus, snap keyboard navigation, Escape and pointer dismissal")
            # A separate context simulates the native boundary. These tests only
            # exercise UI state, not real transfers, dialogs or OS integration.
            quick = browser.new_context(viewport={"width": 460, "height": 620}, locale="en-US", reduced_motion="reduce")
            quick.add_init_script("""(() => {
              localStorage.setItem('homeplace-language', 'en');
              const callbacks = new Map(), events = new Map();
              let nextId = 0;
              window.testNative = { pending: null, files: [], calls: [], finishSend: null, rejectSend: null };
              window.testEvent = (event, payload) => {
                for (const [id, entry] of events) if (entry.event === event)
                  callbacks.get(entry.handler)?.({ event, id, payload });
              };
              window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
              const snapshot = () => JSON.parse(localStorage.getItem('test-shared-transfers') || '{"revision":0,"transfers":[]}');
              const publish = value => { localStorage.setItem('test-shared-transfers', JSON.stringify(value)); window.testEvent('shared-transfers-changed', value); };
              window.addEventListener('storage', event => {
                if (event.key === 'test-shared-transfers') window.testEvent('shared-transfers-changed', snapshot());
                if (event.key === 'test-cancel' && event.newValue === window.testNative.runId) window.testNative.rejectSend?.('The transfer was cancelled.');
              });
              window.__TAURI_INTERNALS__ = {
                metadata: { currentWindow: { label: location.search === '?main' ? 'main' : 'quick-share' }, currentWebview: { label: location.search === '?main' ? 'main' : 'quick-share' } },
                transformCallback: callback => { callbacks.set(++nextId, callback); return nextId; },
                unregisterCallback: id => callbacks.delete(id),
                invoke: async (command, args = {}) => {
                  window.testNative.calls.push({ command, args });
                  if (command === 'plugin:event|listen') { events.set(++nextId, args); return nextId; }
                  if (command === 'plugin:event|unlisten') { events.delete(args.eventId); return; }
                  if (command === 'plugin:window|is_visible') return true;
                  if (command === 'get_file_transfer_limit') return 524288000;
                  if (command === 'platform_info') return { platform:'windows', label:'Windows', deviceName:'Test PC', secureStorage:'Credential Manager', tray:true, platformVersion:'11', capabilities:[], protocolMin:1, protocolMax:1 };
                  if (command === 'connection_profiles') return { profiles:[] };
                  if (command === 'startup_status' || command === 'clipboard_sync_status' || command === 'system_notification_status') return { enabled:false };
                  if (command === 'cancel_share_send') {
                    localStorage.setItem('test-cancel', args.operationId);
                    if (window.testNative.runId === args.operationId) window.testNative.rejectSend?.('The transfer was cancelled.');
                    return true;
                  }
                  if (command === 'shared_transfers') return snapshot();
                  if (command === 'start_shared_transfer') {
                    const value = snapshot();
                    if (value.transfers.some(item => item.status === 'sending')) throw 'A transfer is already active.';
                    value.revision++;
                    value.transfers.unshift({ id: args.id, names: args.names, targetName: args.targetName, status: 'sending', progress: null, error: null });
                    publish(value); return;
                  }
                  if (command === 'update_shared_transfer') {
                    const value = snapshot(), item = value.transfers.find(item => item.id === args.id);
                    if (item.status !== 'sending') return;
                    Object.assign(item, { status: args.status, progress: args.progress || item.progress, error: args.error });
                    value.revision++; publish(value); return;
                  }
                  if (command === 'take_pending_share') { const value = window.testNative.pending; window.testNative.pending = null; return value; }
                  if (command === 'pick_share_files') return window.testNative.files;
                  if (command === 'list_account_devices') return [];
                  if (command === 'list_share_targets') return [
                    { id: 'mac', name: 'Test Mac', platform: 'macos', online: true, ownerName: 'Test', supportsFile: true, supportsText: true, supportsUrl: true },
                    { id: 'phone', name: 'Galaxy S24', platform: 'android', online: false, ownerName: 'Test', supportsFile: true, supportsText: true, supportsUrl: true },
                    { id: 'pc', name: 'Windows Desktop', platform: 'windows', online: true, ownerName: 'Test', supportsFile: true, supportsText: true, supportsUrl: true }
                  ];
                  if (command === 'send_share_file') return new Promise((resolve, reject) => { window.testNative.runId = args.operationId; window.testNative.finishSend = resolve; window.testNative.rejectSend = reject; });
                  return null;
                }
              };
            })();""")
            share = quick.new_page()
            share.on("pageerror", lambda error: errors.append(str(error)))
            share.goto("http://127.0.0.1:1420")
            share.wait_for_load_state("networkidle")
            choose = share.get_by_role("button", name="Choose files…", exact=True)
            expect(choose).to_be_visible()
            expect(share.get_by_role('button', name='Send to Test Mac', exact=True)).to_be_visible()
            share.screenshot(path=str(output / 'quick-share-empty.png'), full_page=True)
            share.evaluate("testNative.files = ['C:/test/one.txt']")
            choose.click()
            expect(share.locator(".quick-share-payload b")).to_have_text("one.txt")
            share.evaluate("testNative.files = []")
            choose.click()
            expect(share.locator(".quick-share-payload b")).to_have_text("one.txt")
            share.evaluate("testEvent('quick-share-blurred', null)")
            expect(choose).to_be_visible()
            share.get_by_role("button", name="Send to Test Mac", exact=True).click()
            share.wait_for_function("testNative.finishSend !== null")
            observer = quick.new_page()
            observer.set_viewport_size({'width':720, 'height':560})
            observer.on('pageerror', lambda error: errors.append(str(error)))
            observer.goto('http://127.0.0.1:1420?main')
            observer.wait_for_load_state('networkidle')
            observer.get_by_role('button', name='Transfers', exact=True).click()
            expect(observer.get_by_role('region', name='Outgoing transfers')).to_contain_text('one.txt')
            expect(observer.get_by_role('button', name='Cancel', exact=True)).to_be_visible()
            share.evaluate("testNative.pending = { files: ['C:/test/two.txt'], text: null, error: null }; testEvent('quick-share-staged', null)")
            expect(share.locator(".quick-share-payload b")).to_have_text("one.txt")
            share.evaluate("testNative.finishSend()")
            expect(observer.get_by_role('region', name='Outgoing transfers')).to_contain_text('Sent')
            assert observer.evaluate('document.documentElement.scrollHeight <= innerHeight + 2'), 'Main window has an outer scrollbar'
            assert observer.locator('.app-content').evaluate('element => element.getBoundingClientRect().top >= 40'), 'Content overlaps the window caption'
            observer.locator('.app-content').evaluate('element => element.scrollTop = 150')
            assert observer.locator('.window-controls').evaluate('element => element.getBoundingClientRect().top == 0'), 'Window controls scroll with content'
            observer.locator('.app-content').evaluate('element => element.scrollTop = 0')
            observer.screenshot(path=str(output / 'main-transfer-history.png'), full_page=True)
            observer.evaluate("testNative.files = ['C:/test/three.txt']")
            observer.locator('.share-drop-zone').click()
            observer.locator('.share-composer-targets button').filter(has_text='Test Mac').click()
            observer.wait_for_function('testNative.finishSend !== null')
            expect(share.get_by_role('region', name='Outgoing transfers')).to_contain_text('three.txt')
            share.get_by_role('button', name='Cancel', exact=True).click()
            expect(observer.get_by_role('region', name='Outgoing transfers')).to_contain_text('Cancelled')
            expect(share.get_by_role('region', name='Outgoing transfers')).to_contain_text('Cancelled')
            observer.close()
            expect(share.locator(".quick-share-payload b")).to_have_text("two.txt")
            assert share.evaluate("testNative.calls.filter(call => call.command === 'send_share_file').length") == 1
            share.screenshot(path=str(output / "quick-share.png"), full_page=True)
            for theme in ("dark", "light"):
                share.evaluate("theme => document.documentElement.dataset.theme = theme", theme)
                share.set_viewport_size({"width": 400, "height": 480})
                assert share.evaluate("document.documentElement.scrollWidth <= innerWidth"), "QuickShare overflows horizontally"
                assert share.evaluate("document.documentElement.scrollHeight <= innerHeight + 2"), "QuickShare has an outer scrollbar"
                expect(share.get_by_role("button", name="Send to Test Mac", exact=True)).to_be_visible()
                share.screenshot(path=str(output / f"quick-share-{theme}-minimum.png"), full_page=True)
            share.evaluate("testEvent('quick-share-stage-files', Array.from({length: 21}, (_, i) => 'C:/test/extra' + i + '.txt'))")
            expect(share.get_by_role("alert")).to_contain_text("Choose up to 20 files")
            expect(share.locator(".quick-share-payload b")).to_have_text("two.txt")
            assert not errors, errors
            print("PASS: QuickShare draft on cancelled picker, persistence on blur, queued request during send (mock native boundary)")
            for platform, user_agent in (
                ("macos", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15"),
                ("linux", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"),
            ):
                preview = browser.new_context(user_agent=user_agent, viewport={"width": 1200, "height": 800})
                platform_page = preview.new_page()
                platform_page.on("pageerror", lambda error: errors.append(str(error)))
                platform_page.goto("http://127.0.0.1:1420")
                platform_page.wait_for_load_state("networkidle")
                expect(platform_page.locator("html")).to_have_attribute("data-platform", platform)
                expect(platform_page.locator(".window-controls")).to_have_count(0)
                expect(platform_page.locator(".app-sidebar")).to_be_visible()
                preview.close()
            assert not errors, errors
            print("PASS: macOS/Linux platform branching (browser previews, not native builds)")
            print("Screenshots:", output)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
