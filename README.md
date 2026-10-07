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
| `schoolpass_list_drivers` | Authorized pickup drivers; `include_carpool: true` adds their carpools (other families' contact/vehicle fields dropped unless `view: "full"`). |
| `schoolpass_get_calendar` | A student's arrival/dismissal calendar over a date range. |
| `schoolpass_list_pickup_changes` | Pickup/dismissal changes for a student on a date. |
| `schoolpass_list_dismissal_locations` | The school's dismissal locations, with ids. |
| `schoolpass_get_school_info` | Basic school info and per-school config. |
| `schoolpass_submit_dismissal_change` | Submit a dismissal/arrival change (confirm-gated: preview + single-use `confirmToken`). |
| `schoolpass_cancel_dismissal_change` | Cancel a change, back to default (confirm-gated: preview + `confirmToken`). |

## Configuration

| Env var | Required | Notes |
|---------|----------|-------|
| `SCHOOLPASS_EMAIL` | yes | Your SchoolPass parent account email. |
| `SCHOOLPASS_PASSWORD` | yes | Your SchoolPass password. |
| `SCHOOLPASS_SCHOOL_CODE` | yes | The numeric school id (the `AppCode` / `appCode` value; e.g. `1183`). |
| `SCHOOLPASS_API_HOST` | no | Regional API host override (default `busapi-east16-ss.school-pass.net`). |
| `MCP_CONFIRM_MODE` | no | How the two writes confirm on a client that cannot show a prompt: `ask-user` (default — preview + token, the user approves in chat), `auto` (the model may use the token after reviewing the preview), or `refuse`. |
| `MCP_CONFIRM_ELICITATION` | no | `off` never shows a confirmation prompt, so every client gets the `MCP_CONFIRM_MODE` behaviour. Set it for a client that says it can show prompts but never does (the write hangs — opencode 2.0.x). Default `on`; any other value is treated as `on`, with a warning on stderr. |
| `MCP_CONFIRM_TTL_SECONDS` | no | How long a confirm token stays valid (default `600`). |
| `MCP_CONFIRM_SECRET` | no | HMAC key for confirm tokens; set only if tokens must survive a restart. On mcp-host the host supplies a stable per-child key (`MCP_HOST_CONFIRM_SECRET`) and spent tokens are recorded under `MCP_DATA_DIR`, so an approval survives an idle restart. |

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
  repeated failures can get the account challenged. A password SchoolPass
  refuses (400/401) is tried once per process: later calls return the same
  error without contacting SchoolPass until the configured credentials change
  or the server restarts. A CDN/WAF block page (CloudFront, Cloudflare, …) is
  not a refusal: it is reported as an edge block, never latched, and never
  spends or discards the stored session.
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
