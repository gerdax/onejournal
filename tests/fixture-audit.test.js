'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startFixture } = require('./fixture-server.cjs');

test('audit fixture keeps failures isolated and notifications explicit', async () => {
  const fixture = await startFixture({ tokenCount: 10 });
  const request = async body => {
    const response = await fetch(fixture.url + '/functions/v1/onejournal', {
      method: 'POST', headers: { Authorization: 'Bearer audit-user', 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const exchange = await request({ action: 'exchange', secret: fixture.secrets.gm });
    assert.equal(exchange.body.participants.length, 10);
    const id = exchange.body.participants[0].id;
    const original = fixture.document.state.map.positions[id];
    let notifications = 0;
    const unsubscribe = fixture.audit.subscribeSnapshots(() => notifications++);
    fixture.audit.failNext('moveToken', 503);
    assert.equal((await request({ action: 'command', method: 'moveToken', args: [id, 400, 400] })).status, 503);
    assert.deepEqual(fixture.document.state.map.positions[id], original);
    assert.equal((await request({ action: 'command', method: 'moveToken', args: [id, 400, 400] })).status, 200);
    assert.deepEqual(fixture.document.state.map.positions[id], { x: 400, y: 400 });
    assert.equal(notifications, 0, 'writes never pretend to emit realtime');
    await fixture.audit.notifySnapshots(); assert.equal(notifications, 1);
    unsubscribe(); await fixture.audit.notifySnapshots(); assert.equal(notifications, 1);
    assert.ok(fixture.audit.requests.every(r => r.responseBytes > 0 && r.completed >= r.handled && r.handled >= r.started));
  } finally { await fixture.close(); }
});

test('audit delay holds responses after handling, and default fixture remains three tokens', async () => {
  const fixture = await startFixture();
  try {
    assert.equal(fixture.document.state.battle.length + fixture.document.state.heroParticipants.length, 3);
    assert.throws(() => fixture.audit.setResponseDelay(-1), /Invalid/);
    fixture.audit.setResponseDelay(40);
    await fetch(fixture.url + '/functions/v1/onejournal', {
      method: 'POST', headers: { Authorization: 'Bearer delayed-user', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'exchange', secret: fixture.secrets.gm })
    }).then(response => response.json());
    const record = fixture.audit.requests[0];
    assert.ok(record.completed - record.handled >= 30, 'response hold is measured separately from core handling');
    fixture.audit.setResponseDelay(0);
  } finally { await fixture.close(); }
});
