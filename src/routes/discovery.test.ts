// Discovery contract: MCP clients may probe RFC 8414 / RFC 9728 metadata at
// either the bare well-known path or the /mcp-suffixed variant (path insertion
// for resource https://host/mcp). Both must be mounted or strict clients
// report "does not implement OAuth". Source-reading test, same style as
// entrypoints.test.ts — no live server needed.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const code = readFileSync(join(root, 'src/routes/oauth.ts'), 'utf8')

describe('OAuth discovery mounts', () => {
  it('serves protected-resource metadata at bare + /mcp paths', () => {
    assert.ok(code.includes("'/.well-known/oauth-protected-resource'"))
    assert.ok(code.includes("'/.well-known/oauth-protected-resource/mcp'"))
  })
  it('serves authorization-server metadata at bare + /mcp paths', () => {
    assert.ok(code.includes("'/.well-known/oauth-authorization-server'"))
    assert.ok(code.includes("'/.well-known/oauth-authorization-server/mcp'"))
  })
})
