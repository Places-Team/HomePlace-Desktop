# Ideas across devices

Ideas and user-created sections now belong to the HomePlace account, rather than to a particular desktop installation. The Desktop Ideas board reads and changes them through `GET` and `POST /api/link/ideas`. The API contract for Mobile is documented in the HomePlace server repository at `docs/link-ideas-api.md`.

New pairings request `ideas.manage`. A device paired before this permission was added must be paired again and the new scope approved before it can use Ideas. Desktop does not receive the device bearer token in its web interface; the Rust Link client performs the authenticated requests.

On a desktop that has ideas in the former local store, the Ideas board offers an explicit import. It transfers ideas in batches, preserves the old local copy, and can be repeated safely: the server deduplicates each imported idea by account and legacy ID. The board never silently merges local ideas into a different server account. The Re-import action remains available after a successful transfer, including if the account linked to the server changes later.

The Inbox section is built in. Deleting another section moves its ideas into Inbox. Search, pinning, archiving, and section filtering are server-backed; the interface loads further pages on demand. Mobile should use this same account-scoped API and request `ideas.manage` during pairing, not create a separate ideas database.
