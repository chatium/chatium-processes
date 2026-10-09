import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const sha = value => createHash('sha256').update(value).digest('hex')
const ROLES = new Set(['kb-review', 'code-review', 'creative-review', 'agent-review', 'architecture-review', 'analytics-review'])

export function markReviewPacket({ directory, root, slug, role, managed }) {
  if (!managed) return
  if (!ROLES.has(role) || !basename(directory).startsWith(`${role}-${slug}-`))
    throw Error('Некорректное имя управляемого пакета ревью.')
  const marker = { version: 1, managed: true, account: realpathSync(root), process: slug, role,
    createdAt: new Date().toISOString(), packetSha256: sha(readFileSync(join(directory, 'packet.json'))) }
  writeFileSync(join(directory, '.processes-review-packet.json'), JSON.stringify(marker) + '\n', { flag: 'wx' })
}

/** Only marked packets for this account, idle for the chosen period, can be removed. */
export function reviewPacketCleanup({ base, root, days = 30, apply = false, now = Date.now() }) {
  if (!Number.isInteger(days) || days < 0) throw Error('Неверный срок хранения пакетов.')
  if (!existsSync(base)) return { candidates: [], removed: [] }
  const account = realpathSync(root), candidates = [], removed = []
  for (const name of readdirSync(base).sort()) {
    const directory = join(base, name), markerPath = join(directory, '.processes-review-packet.json')
    if (!lstatSync(directory).isDirectory() || !existsSync(markerPath) || lstatSync(markerPath).isSymbolicLink()) continue
    let marker
    try { marker = JSON.parse(readFileSync(markerPath, 'utf8')) } catch { continue }
    let packetHash
    try { packetHash = sha(readFileSync(join(directory, 'packet.json'))) } catch { continue }
    if (marker.version !== 1 || marker.managed !== true || marker.account !== account ||
        !ROLES.has(marker.role) || !name.startsWith(`${marker.role}-${marker.process}-`) ||
        !/^[a-z0-9][a-z0-9-]*$/.test(marker.process) ||
        packetHash !== marker.packetSha256) continue
    let recent = 0, entries = 0, unsafe = false
    function inspect(path) {
      if (++entries > 5000) { unsafe = true; return }
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) { unsafe = true; return }
      recent = Math.max(recent, stat.mtimeMs)
      if (stat.isDirectory()) for (const child of readdirSync(path)) inspect(join(path, child))
    }
    try { inspect(directory) } catch { unsafe = true }
    if (unsafe || now - recent < days * 86_400_000) continue
    candidates.push(directory)
    if (apply) { rmSync(directory, { recursive: true }); removed.push(directory) }
  }
  return { candidates, removed }
}
