---
name: schoolpass-mcp
description: This skill should be used when the user asks about their child's school arrival/dismissal through a SchoolPass parent account. Triggers on phrases like "check SchoolPass", "when is my kid dismissed", "what's my dismissal default", "list my students in SchoolPass", "who are my pickup drivers", "any pickup changes today", "school dismissal locations", or any request to read a SchoolPass parent account.
---

# schoolpass-mcp

MCP server for the SchoolPass REST API used by the SchoolPass web and mobile apps — a parent's students, arrival/dismissal calendar, pending pickup changes, authorized drivers, dismissal locations, and school info, using the user's own parent account.

- **npm:** [npmjs.com/package/schoolpass-mcp](https://www.npmjs.com/package/schoolpass-mcp)
- **Source:** [github.com/chrischall/schoolpass-mcp](https://github.com/chrischall/schoolpass-mcp)

Parent-scoped and read-only in this release.

## Setup

Add to `.mcp.json` in your project or `~/.claude/mcp.json`:

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

`SCHOOLPASS_SCHOOL_CODE` is the numeric school id (the `AppCode` / `appCode`
value the app uses; e.g. 1183 for Scholars Academy). Set `SCHOOLPASS_API_HOST`
too if your school is on a different regional shard than the default
`busapi-east16-ss.school-pass.net`.

## First call

Start with `schoolpass_healthcheck` — it reports whether the API host is
reachable and, separately, whether the credentials log in, so a network problem
reads differently from a wrong password or school code. Then `schoolpass_whoami`
confirms the parent identity, and `schoolpass_list_students` gives you the
student ids the calendar and pickup-change tools need.

**If a login is rejected, STOP.** SchoolPass fronts its login with reCAPTCHA;
repeated failures can get the account challenged. Tell the user to check the
email/password/school-code — never retry with a guess.

## Tools

| Tool | Notes |
|------|-------|
| `schoolpass_healthcheck` | Reachability + auth, separated. No secrets in the output. Start here when a tool says it is not configured. |
| `schoolpass_whoami` | The parent identity the server signed in as (member id, user type, name). |
| `schoolpass_list_students` | The parent's linked students — name, grade, home dismissal location, aftercare. Gives the `student_id` other tools need. |
| `schoolpass_get_profile` | The parent account profile. |
| `schoolpass_list_drivers` | Authorized pickup drivers, with their carpools. |
| `schoolpass_get_calendar(student_id, start_date?, end_date?)` | A student's arrival/dismissal calendar over a range (defaults today → 14 days out). |
| `schoolpass_list_pickup_changes(student_id, date?)` | Pickup/dismissal changes for a student on a date (defaults today). |
| `schoolpass_list_dismissal_locations` | The school's dismissal locations (car line, bus, aftercare, walkers…) with ids. |
| `schoolpass_get_school_info` | Basic school info and per-school config. |

## Notes

- **Parent scope only.** A parent token cannot reach admin routes (visitor
  management, carline operations, reports, bus routing); those return `403` with
  a hint saying so.
- **Read-only.** Submitting an alternate pickup / dismissal change is not yet a
  tool — it mutates a child's real dismissal, so it will arrive later as a
  `confirm`-gated tool once its request shape is verified against a real change.
- **Never echo the password or a session token** into the conversation.
