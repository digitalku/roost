# Roost Remote — the protocol a phone speaks

**API version 1 · Document revision 1.0 · Status: DRAFT**

**Normative for a client.** This is what an application on another device, the Android client
first, writes against to open a library that a Roost window is sharing on the local network
(ADR-0072). That client is **Roost Remote**, in its own repository, `../roost-remote-android`. It is to that client what `FORMAT.md` is to a library: requirements are numbered
`RR-n` and use **MUST**, **SHOULD** and **MAY** in the usual sense, and text outside a numbered
requirement explains and binds nothing.

The server is `@roost/server`, carried by the window's main process. The requests and their
answers are **`@roost/contract`'s**, the same ones a window sends, so `packages/contract/src/`
(`request.ts`, `dto.ts`, `event.ts`) is the reference for every shape named below. This document
says how they travel, what a client may send, and what it owes the person holding the phone.

---

## 1. Finding and reaching the server

**RR-1.** The owner turns sharing on in the window, under **Share on this network…** in the `☰`,
for one library at a time. The window then lists the addresses to type, such as
`http://192.168.1.20:7387`, and a Tailscale address where there is one. A client MUST let the owner
type an address, and SHOULD remember it per library.

The server answers only addresses on a local network: loopback, the private IPv4 ranges,
link-local, IPv6 unique-local and link-local, and `100.64.0.0/10`, which is where Tailscale numbers
its devices. Any other address is closed without an answer. The default port is **7387**.

**RR-2.** Every route is under `/api/1/`, where `1` is the API version, or under `/bytes/`. A server
of a later version that keeps version 1 keeps these routes. A client meeting a `hello` whose `api`
it does not know MUST say so rather than guess.

**RR-3. The transport is plain HTTP** in this version (ADR-0072 §3.4, the owner's choice). On a home
network the password at pairing and the token on every request cross unencrypted. Through
Tailscale they are encrypted by Tailscale. An Android client therefore needs cleartext traffic
allowed for the addresses it is given; it SHOULD allow it for those hosts only, through its
network security configuration, rather than everywhere.

*Reserved.* HTTPS with a certificate the client pins at pairing is the planned next step. It will
keep every route below unchanged.

## 2. Pairing

**RR-4.** `GET /api/1/hello` needs no token and answers:

```json
{ "api": 1, "build": "0.2.10", "library": { "id": "7b2e9c41-…", "name": "pribadi" } }
```

`library` is `null` while sharing is on and the window has no library open. A client SHOULD show the
name before asking for the password, so the owner knows which library they are about to pair with.

**RR-5.** `POST /api/1/pair` with `{ "password": "…", "device": "Pixel 9" }` pairs the device under
the library's password (ADR-0071). `device` is a name of 1 to 64 characters that the window will
show in its list. The answer is:

```json
{ "token": "64 lowercase hex characters", "device": { "id": "…", "name": "Pixel 9", "pairedAt": 1800000000, "lastSeen": null } }
```

**RR-6.** The token is shown once. A client MUST keep it in the platform's protected storage (on
Android, the keystore), MUST NOT keep the password once pairing has answered, and MUST send the
token on every later request as `Authorization: Bearer <token>`. Nothing else identifies a device:
there is no account.

**RR-7.** A token stops working when the owner unpairs the device in the window, and **every** token
stops working when the library's password changes. Either way the next request answers `401
not_paired`, and a client MUST then forget the token and offer to pair again.

Pairing refusals: `403 password_wrong`; `429 too_many_attempts` after five wrong passwords in a
minute from one address, for a minute; `503 not_shared` when no library with a password is shared.

## 3. Requests

**RR-8.** `POST /api/1/request` carries one contract `Request` as its JSON body, exactly as a window
would send it, and answers with an `Outcome`:

```json
{ "ok": true, "value": … }
{ "ok": false, "problem": { "code": "unknown_asset", "message": "…", "detail": {} } }
```

The body is checked as a window's is. **A field the contract requires MUST be sent, `null`
included**: `assets:page` takes `"after": null` and `"sort": null` for the first page of the
library's own order, and leaving either out is `400 invalid_request`. A problem the engine raised
comes back with HTTP 200 and `ok: false`, as it does in the window, and `problem.code` is the stable
code a client branches on.

**RR-9.** Only these requests are answered away from the machine (ADR-0072 §3.6). Any other is
`403 not_allowed_remotely`.

| | |
|---|---|
| Reading | `library:current`, `library:stats`, `library:sidebar`, `assets:page`, `assets:count`, `query:check`, `query:split`, `query:join`, `query:subfolders`, `facets:vocabulary`, `settings:read`, `asset:detail`, `asset:summary`, `asset:readText`, `folder:covers`, `folder:find`, `folder:deletePreview`, `assets:deleteInFolderPreview`, `tags:list`, `derive:status`, `derive:onScreen` |
| Writing | `asset:rate`, `asset:note`, `asset:source`, `asset:rename`, `asset:tagAdd`, `asset:tagRemove`, `asset:folderAdd`, `asset:folderRemove`, `folder:create`, `folder:rename`, `folder:move`, `tag:create`, `tag:rename`, `tag:group`, `tagGroup:create`, `tagGroup:rename`, `comment:add`, `comment:set`, `comment:remove`, `assets:trash`, `assets:restore`, `assets:deleteInFolder` |
| Deleting for good | `assets:remove`, `assets:emptyTrash`, `folder:delete`, `tag:delete`, `tagGroup:delete` |

Every write is journalled by the engine exactly as the window's is, and a window holding the library
sees it at once.

**RR-10. A client MUST confirm before deleting for good**, saying what the window says: what will be
deleted, how many, and that it cannot be undone. It MUST ask the matching `…Preview` request first
where one exists (`folder:deletePreview` before `folder:delete`) and show what it answers. The server
cannot see a confirmation, so this requirement is the only thing standing between a slip and a lost
file. `assets:trash` is the reversible way, and a client SHOULD make it the ordinary one.

**RR-11.** `derive:onScreen` with the ids a client is showing asks the engine to draw their
thumbnails, as the window does (ADR-0065). A client SHOULD send it for what is on its screen, and
SHOULD NOT send it for a whole library.

## 4. Events

**RR-12.** `GET /api/1/events`, with the token, is a stream of server-sent events. Each one is an
`event:` line naming the type and a `data:` line holding the contract `Event` as JSON. These four
are sent:

| | |
|---|---|
| `library:changed` | Something a listing cannot see changed. Re-read what is on screen |
| `assets:derived` | These assets have new pictures. Load their thumbnails again (their address changed) |
| `library:renamed` | The library has a new name |
| `library:lost` | The window closed the library. Sharing stops with it |

A comment line, `: ping`, arrives every 25 seconds so that the connection stays open. A client
SHOULD reconnect after a dropped stream, and MUST re-read what it shows after reconnecting, because
events sent while it was away are not repeated.

## 5. Bytes

**RR-13.** Pictures and files are not in JSON. Each is a `GET`, with the token, at the path the
window loads it from, with `roost://` replaced by `/bytes/`:

| | |
|---|---|
| `/bytes/thumb/<id>@256`, `@512` | The thumbnail, WebP |
| `/bytes/file/<id>` | The file itself, with `Range`, for video and audio as well |
| `/bytes/render/<id>` | A picture a viewer can draw, for a file that is not one (HEIC, RAW, TIFF) |
| `/bytes/subtitle/<id>` | A caption track, as WebVTT |
| `/bytes/page/<id>/<index>@<width>` | One page of a document, `<index>` from 0, `<width>` 512 or 1024 |

**RR-14. A thumbnail's address carries what changes its pixels**, because the server answers it as
`immutable` for a year: `?at=<posterMs>&v=<derivedAt>`, each part only when the card's field is not
`null`, in that order, as the window builds it (`apps/desktop/renderer/src/thumbnail.ts`). A client
MUST build it the same way, and MUST build it again when `assets:derived` names the asset, or it
goes on showing the old picture. `/bytes/file/` takes `?h=<content hash>` for the same reason.

A missing thumbnail is a 404 with a short cache life, not an error: the picture has not been drawn
yet, and `derive:onScreen` is how to ask for it.

## 6. Status codes

| | |
|---|---|
| 200 | Answered. For `/api/1/request`, read `ok` |
| 400 `invalid_request` | The body is not JSON, or not a request the contract accepts |
| 401 `not_paired` | No token, a token unpaired, or a password changed since (RR-7) |
| 403 `not_allowed_remotely`, `password_wrong` | RR-9, RR-5 |
| 404 `not_found` | No such route, or no such picture yet |
| 429 `too_many_attempts` | RR-5 |
| 503 `not_shared` | No library with a password is shared now |

Every error body is `{ "ok": false, "problem": { "code", "message", "detail" } }`.

## 7. Changing this document

A change that a version 1 client would misread raises the API version and adds routes under it,
leaving version 1's in place. Anything else raises the document revision. Either one is argued in
an ADR, and lands in the same commit as `@roost/server`.
