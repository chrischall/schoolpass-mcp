# Changelog

## [0.3.1](https://github.com/chrischall/schoolpass-mcp/compare/v0.3.0...v0.3.1) (2026-08-28)


### Bug Fixes

* **egress:** declare every host the server dials in mint.yaml ([#18](https://github.com/chrischall/schoolpass-mcp/issues/18)) ([38bfafd](https://github.com/chrischall/schoolpass-mcp/commit/38bfafd07f90a7e5ccc7b61e2f602caff9295855))

## [0.3.0](https://github.com/chrischall/schoolpass-mcp/compare/v0.2.0...v0.3.0) (2026-08-27)


### Features

* cache the signed-in session so a restart skips the login ([#10](https://github.com/chrischall/schoolpass-mcp/issues/10)) ([7cdfbcd](https://github.com/chrischall/schoolpass-mcp/commit/7cdfbcd00ba9ea063fa2b9d862474d473fbd2a7e))


### Bug Fixes

* make the dismissal-change tools prove and target the right thing ([#8](https://github.com/chrischall/schoolpass-mcp/issues/8)) ([3b8a3dd](https://github.com/chrischall/schoolpass-mcp/commit/3b8a3ddc6f99d2a81b74f52dba6ea7eb234b5e3a))
* read the injected env when building the session cache ([#13](https://github.com/chrischall/schoolpass-mcp/issues/13)) ([0a93508](https://github.com/chrischall/schoolpass-mcp/commit/0a93508ca896fb266c33d0197f3fa4f31c6b20f1))
* refresh the stale dismissal docblock and stop verify-write logging PII ([#6](https://github.com/chrischall/schoolpass-mcp/issues/6)) ([23ff0f1](https://github.com/chrischall/schoolpass-mcp/commit/23ff0f1ad32108aadba8fb3ad8a98b3a55c9a809))


### Documentation

* list the cache env vars in server.json and .env.example ([#17](https://github.com/chrischall/schoolpass-mcp/issues/17)) ([d5fd1b9](https://github.com/chrischall/schoolpass-mcp/commit/d5fd1b9aac0da1ba5b4f4d59400ee3ce72ece336))
* **readme:** npm test now typechecks before running vitest ([#16](https://github.com/chrischall/schoolpass-mcp/issues/16)) ([abf5fac](https://github.com/chrischall/schoolpass-mcp/commit/abf5fac336ff45886988e8e518ddf05adc19076b))
* **skill:** declare the name this skill actually publishes under ([#9](https://github.com/chrischall/schoolpass-mcp/issues/9)) ([f1e9ce3](https://github.com/chrischall/schoolpass-mcp/commit/f1e9ce3dd9c6a4107322957196cdddf615b4db51))

## [0.2.0](https://github.com/chrischall/schoolpass-mcp/compare/v0.1.0...v0.2.0) (2026-08-25)


### Features

* submit and cancel dismissal changes (confirm-gated) ([#2](https://github.com/chrischall/schoolpass-mcp/issues/2)) ([12962e4](https://github.com/chrischall/schoolpass-mcp/commit/12962e45ae4d6b2ef957331c9fe536ae99e309ee))

## 0.1.0 (2026-08-24)


### Features

* SchoolPass parent MCP server and curl skill ([a61c087](https://github.com/chrischall/schoolpass-mcp/commit/a61c0875907463915fd143abaaaa3385aef7f993))
