# SchoolPass API notes

Ground-truth notes for the SchoolPass REST API this server talks to. Unlike the
reverse-engineered fleet repos, SchoolPass publishes an OpenAPI/Swagger spec, so
most shapes come from there; the auth-response envelope and the parent tool
shapes are additionally verified against a live parent account (see
`scripts/live-check.mjs`). Every read tool's endpoint is confirmed live against a
real parent account (school 1183); only the deferred write path is unimplemented.

## Topology

- The web app is a classic ASP.NET WebForms site per school subdomain
  (`<school>.school-pass.net`, e.g. `scholarsacademy.school-pass.net`). The
  parent pages there are server-rendered and expose no JSON.
- The JSON API is a separate ASP.NET Core service on a **region-sharded** host,
  `busapi-<region>-ss.school-pass.net` (`busapi-east16-ss.school-pass.net` for
  Scholars Academy). Its Swagger UI is public at `/swagger/index.html` and the
  spec at `/swagger/v1/swagger.json` (541 paths across 61 tags).
- The newer Angular SPA (`schoolpass.cloud`) is a thin client over that same
  JSON API.

## Two facts that shape every call

1. **`AppCode: <schoolCode>` header on every request.** It selects the tenant;
   the same host serves many schools. A call without it (or with the wrong one)
   returns `401`. It is not a secret — a small integer (1183 = Scholars Academy).
2. **Real HTTP status codes.** `401` = token/AppCode rejected, `403` = the
   account lacks permission for that endpoint (a parent hitting an admin route),
   `2xx` = success. Nothing gates on a body-level status field.

## Auth

- Login form (`<school>.school-pass.net/default.aspx`) is a plain
  `POST` of `ent_login` + `password` — **no CSRF token, and reCAPTCHA is on the
  Contact-Us modal, not the login form.** A wrong password returns the page with
  `Incorrect E-mail or password.`; a nonexistent client identity is NOT what you
  get, which is how we know server-side login is viable.
- The JSON API auth flow (what this server uses):

  | Step | Request | Body | Returns |
  |------|---------|------|---------|
  | 1 | `POST Auth/users` | `{schoolCode,email,password,ssoToken:null,authType:"Credentials"}` | the identities that email owns at the school |
  | 2 | `POST Auth/token` | `{schoolCode,userId,userType,password,ssoToken:null,authType:"Credentials"}` | `{ access_token, refresh_token, … }` |
  | 3 | `POST Auth/token/refresh` | `{schoolCode,access_token,refresh_token}` | fresh `{ access_token, refresh_token }` |

  - `authType` goes over the wire as the **string** `"Credentials"` (enum:
    `Credentials`, `Google`, `Blackbaud`, `OneTimeToken`).
  - `userType` enum (index-aligned int32): `NA=0, Visitor=1, Student=2,
    Parent=3, Staff=4, Teacher=5, FlaggedVisitor=6`. A parent account is `3`;
    the web app stores this as `memberType` in localStorage.
  - **`Auth/users` element shape (verified live):** each element nests the id +
    type under a `user` object — `{ user: { userType, internalId }, firstName,
    lastName, email, phoneNumber, externalId, … }`. The parent's member id is
    `user.internalId` (e.g. 15348); it is what every parent endpoint's `memberId`
    query param takes. The client parses this nested shape and falls back to flat
    top-level variants. `access_token` / `refresh_token` field names on the token
    response are confirmed by the spec's `RefreshTokenInputModel` and live.
  - Access token is a JWT; its `exp` claim (epoch seconds) sets the refresh
    window. If it ever carries no `exp`, the client falls back to a 30-minute TTL.

- **Never auto-retry a rejected credential.** SchoolPass fronts its login with
  reCAPTCHA; hammering the auth endpoint with wrong passwords risks a challenge
  on the account. On a `400`/`401` from an auth endpoint the client throws once
  and stops.

## Unauthenticated probes (verified live)

- `GET version?schoolCode=<sc>` (AppCode header) → a status string, e.g.
  `Host:…,Version:5.0.4.7602,…,School:SprAPiServer 1183 Scholars Academy`. Used
  by the healthcheck to prove reachability + the region host.
- `GET Config/configsettings?schoolCode=<sc>` (AppCode header) → per-school
  config JSON (`showCarline`, `showBus`, `autoSignoutMinutes`, …). Public.
- `GET SchoolInfo/GetBasicSchoolInfo?schoolCode=<sc>` → **401 without a bearer.**

## Parent-scoped endpoints this server uses

All are `GET` and take the `AppCode` header. The parent endpoints take a
`memberId` = the parent's `user.internalId`; `parent/getstudents` 500s without
it, so this server always passes it.

| Endpoint | Params | Notes |
|----------|--------|-------|
| `parent/getstudents` | `memberId` (required) | Array of `Student` (id, firstName, lastName, dismissalLocationId, gradeId, aftercare, sitePrefix, …). Verified live. |
| `parent/profile` | `memberId?` | Parent account profile: `carpoolName`, `studentNames`, `dismissalNames`, `pickupAreaNames`, `notificationSettings[]`, `parentId`, `user.internalId`. Verified live. |
| `parent/parentdrivers` | `memberId?, includeCarpool?, includeTags?` | Authorized pickup drivers (array of parent-like records with `carpool`, `parentId`, name, contact). Verified live. |
| `Student/StudentCalendar` | `schoolCode, studentId, startDate, endDate` | `{ dailyList: [{ timestamp, studentChangeType, isDefault, adType, description, moveToId, changeId, changeSeriesId }], studentId, wellnessStatus, siteId }`. Verified live. |
| `PickupChange/GetChanges` | `studentId, date` | Array of pickup/dismissal changes for a student on a date (empty when none pending). Verified live. |
| `dismissal/getDismissalLocations` | — | Array of `DismissalLocation` (id, name, locationTypeId, pickupAreaId, dismissalSessionTimeId). Verified live. |
| `SchoolInfo/GetBasicSchoolInfo` | `schoolCode` | Basic school info: `name`, `phone`, `vehicleIdMethod`, `carpoolType`, image-availability flags (needs bearer). Verified live. |

Parent authorization for each of these is confirmed live (school 1183) — the API
exposes far more (visitor management, carline ops, reports, bus routing), but a
parent token returns `403` for the admin-only routes, so only the subset above
is surfaced.

## Writes — verified live

Submitting and cancelling a dismissal/arrival change is verified end-to-end
against the live account (a MarkAsAbsent change was created, read back, and
deleted, restoring the day to default).

**Submit — `POST studentchange`** (query `schoolCode`, `parentMemberId`). Body
mirrors the app's own `createSubmitPayload` exactly:

```jsonc
{
  "studentId": 11278,
  "moveToId": null,            // target carpool/location id; null for absent
  "busStopId": null,
  "dateSet": {
    "dates": [],               // ALWAYS EMPTY — populating it 500s
    "daysOfWeek": [1],         // NUMERIC ids, Monday=1 … Sunday=7 — a string ("Monday") 500s
    "startDate": "2026-09-14",
    "endDate": "2026-09-14",
    "recurringWeeks": 0
  },
  "notes": "",
  "pickupDropoffPerson": null,
  "willReturn": false,
  "timeOfDay": null,
  "changeSeriesId": 0,
  "changeType": 1,             // E2 enum: Absent=1, LateArrival=2, EarlyDismissal=3, Carpool=4, Activity=5, Bus=6
  "adType": 3,                 // app inits adType to Departure(3); server may normalize (absent stored as Both=4)
  "userType": 3,
  "modifiedBy": 15348          // parent member id (user.internalId); MUST be present, and equals parentMemberId
}
```

Traps, each observed live:
- `modifiedBy` (= the parent's `user.internalId`) is required and must equal the
  `parentMemberId` query param — omitting it 500s.
- `dateSet.dates` must be **empty**; the day is selected by the single-day
  `startDate`/`endDate` range filtered by `daysOfWeek`. An empty `daysOfWeek`
  400s ("Date range does not produce any dates"); a populated `dates` 500s.
- `daysOfWeek` entries are **numeric day ids** (Monday=1 … Sunday=7), not the
  string names the Swagger enum implies.
- `moveToId` for a Carpool move is a **carpool id** (not a dismissal location
  id), and moving to the carpool the student is already in 500s.
- A `200`/`true` is not proof — re-read `Student/StudentCalendar` for the date
  and confirm a non-default entry (`isDefault:false`, a populated `changeSeriesId`)
  appeared. The submit tool does this automatically, and matches the entry
  against the `changeType`/`moveToId` it asked for: a plain before/after diff
  would call an idempotent re-submit a failed write (nothing moves because the
  day is already in the requested state) while passing a write that landed as
  some *other* change. The tool reports that no-op case as `alreadyInPlace`.
- `busStopId` is sent on every submit (the app does the same) but **no Bus
  change has been captured live**, so whether a bus move requires a stop id, and
  what id space it uses, is UNVERIFIED. The `bus_stop_id` tool argument passes
  straight through; treat a bus move as unproven until one is captured.
- `moveToId` is enforced by the submit tool for `carpool` and `bus` — the two
  the notes above name explicitly. `activity` is left optional because no
  capture confirms it needs one, and a wrong refusal is as bad as a wrong write.

**Cancel — `DELETE studentchange/DeleteMobileChange`** (query `schoolCode`,
`ChangeSeriesId`, `ChangeType`, `ADType`, `dt`). Keyed on the `changeSeriesId`
the calendar reports for the change. A date can carry more than one change, so
the cancel tool takes an optional `change_series_id` and REFUSES an ambiguous
date rather than deleting whichever entry happens to come first. Verified: deleting the created change
restored the day to all-default. (`PickupChange/revertToCarpool` returns 500 for
this account and is not used.)
