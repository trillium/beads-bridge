import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'deploy.sh')

function bin(dir: string, name: string, body: string) {
  const p = join(dir, name)
  writeFileSync(p, body)
  chmodSync(p, 0o755)
}

function run(env: Record<string, string>, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-domain-'))
  bin(dir, 'launchctl', `#!/bin/sh
if [ "\$1" = print ] && [ "\$2" = "system/com.beads-bridge.server" ]; then
  if [ "\$LAUNCHCTL_SYSTEM_OK" = 1 ]; then exit 0; fi
  echo "Bad request." >&2
  exit 1
fi
echo "unexpected launchctl \$*" >&2
exit 1
`)
  bin(dir, 'sudo', `#!/bin/sh
if [ "\$SUDO_MODE" = password ]; then
  echo "sudo: a password is required" >&2
  exit 1
fi
if [ "\$SUDO_MODE" = kick-fail ]; then
  echo "Could not find service" >&2
  exit 1
fi
echo "sudo \$*" >> "\$SUDO_LOG"
exit 0
`)
  const r = Bun.spawnSync(['sh', SCRIPT, ...args], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      APP_NAME: 'com.beads-bridge.server',
      HOME: dir,
      SUDO_LOG: join(dir, 'sudo.log'),
      ...env,
    },
  })
  return { dir, r }
}

describe('ops/deploy.sh domain', () => {
  test('system plist selects the system domain and does not restart', () => {
    const plist = join(mkdtempSync(join(tmpdir(), 'plist-')), 'com.beads-bridge.server.plist')
    writeFileSync(plist, '<plist/>')
    const { r } = run(
      { BEADS_BRIDGE_SYSTEM_PLIST: plist, LAUNCHCTL_SYSTEM_OK: '0' },
      ['--restart-plan'],
    )
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString().trim()).toBe('domain=system')
  })

  test('a loaded system job selects the system domain', () => {
    const { r } = run(
      {
        BEADS_BRIDGE_SYSTEM_PLIST: '/no/such/daemon.plist',
        LAUNCHCTL_SYSTEM_OK: '1',
      },
      ['--restart-plan'],
    )
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString().trim()).toBe('domain=system')
  })

  test('no system daemon keeps the gui domain', () => {
    const { r } = run(
      {
        BEADS_BRIDGE_SYSTEM_PLIST: '/no/such/daemon.plist',
        LAUNCHCTL_SYSTEM_OK: '0',
      },
      ['--restart-plan'],
    )
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString().trim()).toBe('domain=gui')
  })

  test('missing sudo -n names the kickstart command and fails', () => {
    const { r } = run({ SUDO_MODE: 'password', DEPLOY_RESTART_HOOK: '1' })
    expect(r.exitCode).not.toBe(0)
    const err = r.stderr.toString()
    expect(err).toContain('sudo -n is not available')
    expect(err).toContain('sudo launchctl kickstart -k system/com.beads-bridge.server')
    expect(r.stdout.toString()).not.toContain('running as pid')
  })

  test('kickstart failure still names the command and does not claim success', () => {
    const { r } = run({ SUDO_MODE: 'kick-fail', DEPLOY_RESTART_HOOK: '1' })
    expect(r.exitCode).not.toBe(0)
    const err = r.stderr.toString()
    expect(err).toContain('Could not find service')
    expect(err).toContain('sudo launchctl kickstart -k system/com.beads-bridge.server')
  })

  test('passwordless sudo kickstarts the system job', () => {
    const { dir, r } = run({ SUDO_MODE: 'ok', DEPLOY_RESTART_HOOK: '1' })
    expect(r.exitCode).toBe(0)
    expect(readFileSync(join(dir, 'sudo.log'), 'utf8')).toContain(
      'sudo -n launchctl kickstart -k system/com.beads-bridge.server',
    )
  })
})
