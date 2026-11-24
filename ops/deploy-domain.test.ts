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

// Full-script runs against a throwaway origin, with launchctl/sudo/lsof/curl/
// pnpm stubbed on PATH. The "old" service process is a real sleeping process.
function fullRun(opts: {
  oldDies: 'after-1s' | 'never' | 'no-old'
  failPath?: string
  waitSecs?: string
}) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-full-'))
  const sh = (cmd: string, cwd: string) => {
    const x = Bun.spawnSync(['sh', '-c', cmd], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
    if (x.exitCode !== 0) throw new Error(`${cmd}: ${x.stderr}`)
    return x.stdout.toString().trim()
  }
  const origin = join(root, 'origin')
  sh(`git init -q -b main ${origin} && git -C ${origin} -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`, root)
  const deployDir = join(root, 'app')
  sh(`git clone -q ${origin} ${deployDir}`, root)
  writeFileSync(join(deployDir, '.env'), 'TAILNET_IP=100.64.0.1\n')
  // .env is untracked; ignore it so the clean-tree guard passes.
  writeFileSync(join(deployDir, '.git', 'info', 'exclude'), '.env\n')

  const stubs = join(root, 'stubs')
  sh(`mkdir -p ${stubs}`, root)
  // Orphaned (reparented to init) so a killed pid is reaped, as launchd would.
  const oldPid = sh('sleep 300 >/dev/null 2>&1 & echo $!', root)
  const events = join(root, 'events.log')
  bin(stubs, 'pnpm', '#!/bin/sh\nexit 0\n')
  bin(stubs, 'launchctl', '#!/bin/sh\n[ "$1" = print ] && exit 0\nexit 1\n')
  const dieCmd = opts.oldDies === 'after-1s' ? `(sleep 1; kill ${oldPid}) >/dev/null 2>&1 &` : ''
  bin(stubs, 'sudo', `#!/bin/sh\n${dieCmd}\nexit 0\n`)
  // Before the kickstart the listener is the old pid; after, a distinct new one.
  const listen = opts.oldDies === 'no-old' ? '' : oldPid
  bin(stubs, 'lsof', `#!/bin/sh
if [ -e "${join(root, 'kicked')}" ]; then echo 999999; else echo "${listen}"; fi
`)
  // kickstart marker: sudo also flips the lsof answer.
  bin(stubs, 'sudo', `#!/bin/sh\ntouch "${join(root, 'kicked')}"\n${dieCmd}\nexit 0\n`)
  bin(stubs, 'curl', `#!/bin/sh
url=""; fmt=0
for a in "$@"; do
  case "$a" in http*) url="$a" ;; *http_code*) fmt=1 ;; esac
done
if ps -p ${oldPid} >/dev/null 2>&1; then alive=alive; else alive=dead; fi
echo "curl old=$alive $url" >> "${events}"
[ "$fmt" = 1 ] || exit 0
case "$url" in
  *"${opts.failPath ?? '/never'}"*) echo 500; exit 0 ;;
  *127.0.0.1:3738/oauth*) echo 000; exit 0 ;;
  *oauth/approve*) echo 404; exit 0 ;;
esac
echo 200
`)
  writeFileSync(join(root, 'daemon.plist'), '')
  const r = Bun.spawnSync(['sh', SCRIPT, 'origin/main'], {
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH}`,
      HOME: root,
      DEPLOY_DIR: deployDir,
      BEADS_BRIDGE_SYSTEM_PLIST: join(root, 'daemon.plist'),
      BEADS_BRIDGE_OLD_EXIT_WAIT: opts.waitSecs ?? '10',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  })
  Bun.spawnSync(['kill', oldPid])
  const log = (() => {
    try { return readFileSync(events, 'utf8') } catch { return '' }
  })()
  return { r, log, oldPid }
}

describe('ops/deploy.sh full run', () => {
  const withPlist = (o: Parameters<typeof fullRun>[0]) => fullRun(o)

  test('system path waits for the old pid to exit before health checks', () => {
    const { r, log } = withPlist({ oldDies: 'after-1s' })
    expect(r.stderr.toString()).not.toContain('did not exit')
    expect(r.exitCode).toBe(0)
    const first = log.split('\n').find((l) => l.startsWith('curl'))
    expect(first).toContain('old=dead')
  }, { timeout: 30000 })

  test('system path fails when the old pid never exits', () => {
    const { r, log } = withPlist({ oldDies: 'never', waitSecs: '1' })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.toString()).toContain('did not exit within 1s')
    expect(log).toBe('')
  }, { timeout: 30000 })

  test('a failed phase exits non-zero and later phases never run', () => {
    const { r, log } = withPlist({ oldDies: 'after-1s', failPath: '/live/timeline' })
    expect(r.exitCode).not.toBe(0)
    const out = r.stdout.toString()
    expect(out).toContain('==> live route check')
    expect(r.stderr.toString()).toContain('live route check failed; stopping')
    expect(out).not.toContain('==> oauth approval boundary')
    expect(out).not.toContain('==> gateway catalog')
    expect(log).not.toContain('oauth/approve')
  }, { timeout: 30000 })
})
