import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearLost, dismissLost, lostAnswers, nextAttempt, onLostChange, rememberLost } from './lostAnswers.ts'

test('★ failed answers: one per card, told to every listener, cleared by a later success of that card or by dismissing', () => {
  let told = 0
  const off = onLostChange(() => told++)
  const a = { endpointId: 'e1', sessionId: 'agy-1', key: 'k1', summary: 'make' }
  const b = { endpointId: 'e1', sessionId: 'agy-2', key: 'k2', summary: 'ls' }
  rememberLost(a, 'The card changed', nextAttempt())
  rememberLost(b, 'network', nextAttempt(), true)
  assert.equal(told, 2)
  assert.deepEqual(lostAnswers().map(([, l]) => [l.summary, l.unknown ?? false]), [['make', false], ['ls', true]])
  // ★ another card of conversation 1 answered: card k1's failure stays
  clearLost({ ...a, key: 'k9' }, nextAttempt())
  assert.deepEqual(lostAnswers().map(([, l]) => l.summary), ['make', 'ls'])
  // the same card (raised again after a failed key) answered: its failure goes
  clearLost(a, nextAttempt())
  assert.deepEqual(lostAnswers().map(([, l]) => l.summary), ['ls'])
  dismissLost(lostAnswers()[0]![0])
  assert.deepEqual(lostAnswers(), [])
  off()
  rememberLost({ ...a, key: 'k7' }, 'x', nextAttempt())
  assert.equal(told, 4, 'not told after unsubscribing (and not for clearing a card with nothing stored)')
  dismissLost(lostAnswers()[0]![0])
})

test('★ a failure answered after a later success of the same card is not shown (replies out of order)', () => {
  const c = { endpointId: 'e2', sessionId: 'agy-3', key: 'k3', summary: 'rm' }
  const first = nextAttempt()
  const retry = nextAttempt()
  clearLost(c, retry)
  rememberLost(c, 'unreachable', first)
  assert.equal(lostAnswers().some(([id]) => id === 'e2|k3'), false)
  // a newer failure of it is shown
  rememberLost(c, 'changed', nextAttempt())
  assert.equal(lostAnswers().some(([id]) => id === 'e2|k3'), true)
  dismissLost('e2|k3')
})

test('★ an older success does not erase a newer failure of the same card', () => {
  const c = { endpointId: 'e3', sessionId: 'agy-4', key: 'k4', summary: 'make' }
  const allow = nextAttempt()
  const deny = nextAttempt()
  rememberLost(c, 'changed', deny)
  clearLost(c, allow)
  assert.equal(lostAnswers().some(([id]) => id === 'e3|k4'), true)
  dismissLost('e3|k4')
})

test('★ an older failure does not replace a newer failure of the same card', () => {
  const c = { endpointId: 'e4', sessionId: 'agy-5', key: 'k5', summary: 'make' }
  const allow = nextAttempt()
  const deny = nextAttempt()
  rememberLost(c, 'The card changed', deny)
  rememberLost(c, 'network', allow, true)
  const [, e] = lostAnswers().find(([id]) => id === 'e4|k5')!
  assert.equal(e.reason, 'The card changed')
  assert.equal(e.unknown, undefined)
  dismissLost('e4|k5')
})

test('★ after dismissing a newer failure, an older reply of the same card does not bring the bar back', () => {
  const c = { endpointId: 'e5', sessionId: 'agy-6', key: 'k6', summary: 'make' }
  const allow = nextAttempt()
  const deny = nextAttempt()
  rememberLost(c, 'The card changed', deny)
  dismissLost('e5|k6')
  rememberLost(c, 'network', allow, true)
  assert.equal(lostAnswers().some(([id]) => id === 'e5|k6'), false)
  // a newer failure still shows
  rememberLost(c, 'again', nextAttempt())
  assert.equal(lostAnswers().some(([id]) => id === 'e5|k6'), true)
  dismissLost('e5|k6')
})
