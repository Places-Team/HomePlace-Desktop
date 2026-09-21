# Platform design

## Principle

HomePlace Desktop shares information architecture, terminology and core states,
not one rigid window treatment. Each operating system should feel deliberately
supported.

The shared visual language avoids generic dashboard grids, decorative gradient
glows and a card around every fragment of content. It uses continuous planes,
rules, asymmetric edge details and typography to establish hierarchy. Dark and
light modes are expressed entirely through semantic CSS tokens (`canvas`,
`panel`, `text`, `line`, `accent`, and state colours). Future user themes must
override those tokens instead of introducing component-specific colour rules.

## macOS

The macOS shell is the leading visual implementation.

- Use native vibrancy or visual-effect materials behind the window where the
  installed macOS version supports them.
- Keep primary actions legible on glass with contrast-aware surfaces and a
  solid accessibility fallback.
- Use a compact menu bar popover for connection, quick send, clipboard and
  recent-device actions.
- Use a full settings window for pairing, permissions, transfers and history.
- Respect Reduce Transparency, Reduce Motion, increased contrast and system
  accent colour.
- Follow macOS spacing, toolbar and keyboard conventions instead of copying the
  HomePlace web dashboard into a desktop frame.

The glass treatment is progressive enhancement. Security prompts, destructive
actions and dense logs use stable opaque surfaces even when the surrounding
window is translucent.

## Windows

- Use Mica for the main window and Acrylic only for transient surfaces when the
  operating system supports them.
- Follow Fluent density, focus and keyboard-navigation conventions.
- Provide a notification-area menu with connection and quick-send actions.
- Integrate with Windows notifications and Credential Manager.
- Fall back to an opaque theme for unsupported versions, remote sessions and
  high-contrast mode.

## Linux

- Prefer clear desktop-neutral controls rather than imitating one distribution.
- Support StatusNotifierItem where available and degrade without a tray.
- Use compositor-aware transparency only when it remains readable.
- Integrate with Secret Service and XDG portals before desktop-specific APIs.
- Package behaviour must be consistent across deb, rpm and AppImage targets.

## Shared states

Every shell presents the same product states:

1. no server configured;
2. server verified and waiting for pairing approval;
3. connected and healthy;
4. reconnecting with a visible reason;
5. permission or capability needs attention;
6. revoked or incompatible;
7. update available.

Visual components may differ, but state names and recovery actions must remain
consistent so documentation and support apply across platforms.
