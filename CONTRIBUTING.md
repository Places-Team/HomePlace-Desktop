# Contributing

## Development rules

- Keep protocol and security behaviour shared across platforms.
- Put operating-system behaviour behind a platform adapter.
- Advertise only capabilities that are implemented and currently available.
- Do not add a generic remote shell or automatic execution path.
- Keep credentials and private keys outside the interface process.
- Add tests for protocol changes, command validation and platform fallbacks.
- Update the capability matrix when support changes.

## Commit style

Use concise English imperative commit messages, for example:

```text
Add secure server profile storage
Implement macOS menu bar shell
Reject expired Link commands
```

Keep unrelated platform or protocol changes in separate commits. Do not include
generated attribution or development-tool metadata in commits or pull requests.

