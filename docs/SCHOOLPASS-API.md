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

## Writes — deferred until verified

The one meaningful parent write is submitting an alternate pickup / dismissal
change (`PickupChange/addEarlyPickup`, `addLateArrival`, `moveStudentToCarpool`,
`revertToCarpool`, or `StudentChange/AddMobileChange`). It mutates a child's real
dismissal, so its exact request body must be verified against a **real successful
change** before it ships — and it will be `confirm`-gated with a dry-run preview.
Not implemented in this release.
