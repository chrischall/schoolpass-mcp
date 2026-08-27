# schoolpass-mcp

MCP server for **SchoolPass** — read AND change your child's school arrival &
dismissal from a parent account. Talks to the SchoolPass REST API used by the
SchoolPass web and mobile apps, authenticating server-side with your own parent
email and password (no browser, no extension).

> Developed and maintained by AI (Claude Code). Use at your own discretion.

Parent-scoped: read tools plus a confirm-gated dismissal-change write/cancel.

## Tools

| Tool | What it does |
|------|--------------|
| `schoolpass_healthcheck` | Reachability + authentication, reported separately. |
| `schoolpass_whoami` | The parent identity the server signed in as. |
| `schoolpass_list_students` | Your linked students — name, grade, home dismissal location, aftercare. |
| `schoolpass_get_profile` | The parent account profile. |
| `schoolpass_list_drivers` | Authorized pickup drivers, with their carpools. |
| `schoolpass_get_calendar` | A student's arrival/dismissal calendar over a date range. |
| `schoolpass_list_pickup_changes` | Pickup/dismissal changes for a student on a date. |
| `schoolpass_list_dismissal_locations` | The school's dismissal locations, with ids. |
| `schoolpass_get_school_info` | Basic school info and per-school config. |
| `schoolpass_submit_dismissal_change` | Submit a dismissal/arrival change (confirm-gated, dry-run preview). |
| `schoolpass_cancel_dismissal_change` | Cancel a change, back to default (confirm-gated). |

## Configuration

| Env var | Required | Notes |
|---------|----------|-------|
| `SCHOOLPASS_EMAIL` | yes | Your SchoolPass parent account email. |
| `SCHOOLPASS_PASSWORD` | yes | Your SchoolPass password. |
| `SCHOOLPASS_SCHOOL_CODE` | yes | The numeric school id (the `AppCode` / `appCode` value; e.g. `1183`). |
| `SCHOOLPASS_API_HOST` | no | Regional API host override (default `busapi-east16-ss.school-pass.net`). |

**Finding your school id and region host:** sign into your school's
`<school>.school-pass.net` portal, open the new SchoolPass app, and read
`appCode` (the id) and `apiUrl` (the host) from its browser `localStorage`.

## Install

```json
{
  "mcpServers": {
    "schoolpass": {
      "command": "npx",
      "args": ["-y", "schoolpass-mcp"],
      "env": {
        "SCHOOLPASS_EMAIL": "you@example.com",
        "SCHOOLPASS_PASSWORD": "your-password",
        "SCHOOLPASS_SCHOOL_CODE": "1183"
      }
    }
  }
}
```

## Notes

- **Parent scope only.** A parent token cannot reach admin routes (visitor
  management, carline operations, reports, bus routing); those return `403`.
- **Never retry a rejected login.** SchoolPass fronts its login with reCAPTCHA;
  repeated failures can get the account challenged.
- **No credentials, still boots.** The server starts without configuration and
  answers `tools/list`; the config error surfaces on the first tool call.

## Without the server: `curl`

The SchoolPass API is reachable server-side, so a one-off shell read needs no
MCP process — see the bundled **`schoolpass-curl`** skill
(`skills/schoolpass-curl/`) for a `curl` + `jq` recipe set.

## Development

```bash
npm install
npm test            # tsc typecheck + unit + boot tests
npm run build       # tsc + esbuild bundle
node --env-file=.env scripts/live-check.mjs   # live read-only check (needs .env)
```

## License

MIT
