import assert from 'node:assert/strict'
import { knowledgeAnswer as bounded } from './account/demo/services/knowledgeAnswer.ts'
import { knowledgeAnswer as unbounded } from './knowledgeAnswer-negative.ts'

const searches = []
const result = await bounded({}, {
  async search(_ctx, query) {
    searches.push(query)
    return Array.from({ length: 7 }, (_, i) => ({
      title: `Раздел ${i}`,
      excerpt: 'Инструкция '.repeat(200),
    }))
  },
}, 'Как ответить клиенту?')
assert.equal(searches.length, 1)
assert.deepEqual(searches[0].sectionIds, ['support-instructions'])
assert.equal(searches[0].limit, 5)
assert.equal(result.length, 5)
assert.ok(result.every(hit => hit.excerpt.length <= 700))

const reads = []
await unbounded({}, {
  async listAll(_ctx, offset, limit) {
    reads.push({ offset, limit })
    return Array.from({ length: offset === 0 ? 1000 : 1 }, () => ({ title: 'Раздел', body: 'Текст' }))
  },
}, 'Как ответить клиенту?')
assert.deepEqual(reads, [{ offset: 0, limit: 1000 }, { offset: 1000, limit: 1000 }])
console.log('load fixture: bounded 1 search / 5 excerpts; negative 2 full-page reads')
