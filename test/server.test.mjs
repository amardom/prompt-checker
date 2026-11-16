import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

async function start(t, settings = {}, controlClock = false) {
  const childSetup = controlClock
    ? `let time = 0;
Date.now = () => time;
process.on('message', message => {
  if (message === 'stop') process.exit(0);
  time += message.advanceBy;
  process.send('clock advanced');
});`
    : 'process.on("message",()=>process.exit(0))';
  const child = fork(fileURLToPath(new URL('../server.mts', import.meta.url)), {
    execArgv: ['--import', 'data:text/javascript,' + encodeURIComponent(childSetup)],
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', AI_MODE: 'simulated', ...settings },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.connected) child.send('stop'); await exited; });
  let base;
  let key;
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  for await (const line of createInterface({ input: child.stdout })) {
    if (line.startsWith('Group:')) base = line.split(/\s+/).at(-1);
    if (line.startsWith('Teacher key: ')) {
      key = line.slice('Teacher key: '.length);
      break;
    }
  }
  assert.ok(base && key, stderr || 'Server startup failed.');

  async function request(path, { body, cookie, method, headers, status = 200 } = {}) {
    const response = await fetch(base + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    const expectedStatuses = Array.isArray(status) ? status : [status];
    assert.ok(expectedStatuses.includes(response.status),
      path + ': expected HTTP ' + expectedStatuses.join(' or ') + ', received ' + response.status);
    return response;
  }

  async function join(role, code, cookie) {
    const response = await request('/api/join', { body: { role, code }, cookie });
    const session = response.headers.get('set-cookie');
    assert.match(session, /; HttpOnly; SameSite=Strict; Path=\/$/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return session.split(';')[0];
  }

  const teacher = await join('teacher', key);
  const queue = async () => (await request('/api/teacher/prompts', { cookie: teacher })).json();
  const { groups } = await queue();
  const group = await join('group', ' ' + groups[0].toLowerCase() + ' ');
  const history = async cookie => (await (await request('/api/prompts', { cookie })).json()).prompts;
  const submit = async (text, cookie = group) => (await request('/api/prompts', { body: { text }, cookie, status: 201 })).json();
  const decide = (id, body, status, cookie = teacher) =>
    request('/api/prompts/' + id + '/decision', { body, cookie, status });

  async function advanceClock(advanceBy) {
    const acknowledgement = once(child, 'message');
    child.send({ advanceBy });
    const [message] = await acknowledgement;
    assert.equal(message, 'clock advanced');
  }

  return { request, join, key, teacher, group, groups, queue, history, submit, decide, advanceClock };
}

test('serves both views and assets with their expected content types', { timeout: 10000 }, async t => {
  const { request } = await start(t);
  for (const [path, type, marker] of [
    ['/', 'text/html', 'Send for review'],
    ['/teacher', 'text/html', 'Group codes'],
    ['/client.js', 'text/javascript', 'Generating reply'],
    ['/style.css', 'text/css', 'data-role="teacher"'],
  ]) {
    const response = await request(path);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.ok((await response.text()).includes(marker));
  }
  await request('/missing', { status: 404 });
  await request('/missing', { body: {}, status: 404 });
});

test('protects teacher decisions and keeps group histories separate', { timeout: 10000 }, async t => {
  const app = await start(t);
  const other = await app.join('group', app.groups[1]);
  await app.request('/api/teacher/prompts', { cookie: other, status: 401 });
  await app.request('/api/prompts', { cookie: app.teacher, status: 401 });
  await app.request('/api/prompts', { body: { text: 'A prompt' }, status: 401 });
  const a = await app.submit('  Solve the whole problem.  ');
  const b = await app.submit('Can we get a hint?', other);
  assert.deepEqual((await app.queue()).prompts, [a, b]);
  await app.request('/api/prompts', { body: { text: 'Another prompt' }, cookie: app.group, status: 409 });
  await app.decide(a.id, { action: 'approve' }, 401, other);
  const returned = await (await app.decide(a.id, { action: 'return', feedback: ' Ask for a hint. ' }, 200)).json();
  assert.deepEqual(returned, { ...a, status: 'returned', feedback: 'Ask for a hint.' });
  await app.decide(a.id, { action: 'approve' }, 409);
  assert.deepEqual(await app.history(app.group), [returned]);
  assert.deepEqual(await app.history(other), [b]);
  const revised = await app.submit('How do we start?');
  await app.decide(revised.id, { action: 'approve' }, 202);
  const approved = await waitFor(() => app.history(app.group), entries => entries.at(-1).status === 'approved');
  assert.equal(approved.at(-1).simulated, true);
  assert.ok(approved.at(-1).reply);
  assert.deepEqual((await app.queue()).prompts, [b]);
});

test('rejects malformed input, invalid decisions, and revoked sessions', { timeout: 10000 }, async t => {
  const app = await start(t);
  for (const [body, status] of [
    ['{', 400], ['null', 400], ['true', 400], [{}, 400], [{ code: 'wrong', role: 'teacher' }, 403],
    [{ code: app.groups[0], role: 'invalid' }, 403], [{ code: 'x'.repeat(17000) }, 413],
  ]) {
    await app.request('/api/join', { body, status });
  }
  await app.request('/api/join', { body: '{}', headers: { 'Content-Type': 'text/plain' }, status: 415 });
  for (const text of [42, '   ', 'x'.repeat(2001)]) {
    await app.request('/api/prompts', { body: { text }, cookie: app.group, status: 400 });
  }
  const prompt = await app.submit('x'.repeat(2000));
  await app.decide(999, { action: 'approve' }, 404);
  for (const body of [{ action: 'skip' }, { action: 'return' }, { action: 'return', feedback: 'x'.repeat(501) }]) {
    await app.decide(prompt.id, body, 400);
  }
  const replacement = await app.join('group', app.groups[0], app.group);
  await app.request('/api/prompts', { cookie: app.group, status: 401 });
  assert.deepEqual(await app.history(replacement), [prompt]);
});

test('limits each group for four minutes after approval and allows immediate revisions', { timeout: 10000 }, async t => {
  const app = await start(t, {}, true);
  const other = await app.join('group', app.groups[1]);
  const original = await app.submit('Solve the whole problem.');
  await app.decide(original.id, { action: 'return', feedback: 'Ask about your next step.' }, 200);
  const revised = await app.submit('Can we get help with the next step?');

  await app.advanceClock(60_000);
  await app.decide(revised.id, { action: 'approve' }, 202);
  await waitFor(() => app.history(app.group), entries => entries.at(-1).status === 'approved');

  const rejoined = await app.join('group', app.groups[0]);
  const next = { text: 'Can we check our next step?' };
  await app.request('/api/prompts', { body: next, cookie: rejoined, status: 429 });
  await app.submit('A different group can still submit.', other);

  await app.advanceClock(239_999);
  await app.request('/api/prompts', { body: next, cookie: rejoined, status: 429 });
  await app.advanceClock(1);
  const accepted = await app.submit(next.text, rejoined);
  assert.equal(accepted.status, 'pending');
});

async function waitFor(read, matches) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await read();
    if (matches(result)) return result;
    await delay(20);
  }
  assert.fail('Prompt did not reach the expected state.');
}

test('calls Ollama only after approval, blocks duplicates, and retries failed generations', { timeout: 10000 }, async t => {
  const calls = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const ollama = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({ path: request.url, method: request.method, body: JSON.parse(Buffer.concat(chunks)) });
    if (calls.length === 1) {
      await held;
      response.writeHead(503).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ message: { content: calls.length === 2 ? '  ' : '  Group the first two terms.  ' } }));
  });
  ollama.listen(0, '127.0.0.1');
  await once(ollama, 'listening');
  t.after(() => { release(); ollama.closeAllConnections(); return new Promise(resolve => ollama.close(resolve)); });
  const app = await start(t, { AI_MODE: 'ollama', OLLAMA_PORT: String(ollama.address().port), OLLAMA_MODEL: '' });

  const returned = await app.submit('Solve everything.');
  await app.decide(returned.id, { action: 'return', feedback: '' }, 200);
  const text = 'How should we group these terms?';
  const prompt = await app.submit(text);
  assert.equal(calls.length, 0);
  const generating = await (await app.decide(prompt.id, { action: 'approve' }, 202)).json();
  assert.equal(generating.status, 'generating');
  assert.deepEqual((await app.queue()).prompts, []);
  await app.decide(prompt.id, { action: 'approve' }, 409);
  await app.request('/api/prompts', { body: { text }, cookie: app.group, status: 409 });
  release();
  const failed = entries => entries.at(-1).status === 'pending' && entries.at(-1).generationFailed;
  await waitFor(() => app.history(app.group), failed);
  await app.decide(prompt.id, { action: 'approve' }, 202);
  await waitFor(() => app.history(app.group), failed);
  await app.decide(prompt.id, { action: 'approve' }, 202);
  const history = await waitFor(() => app.history(app.group), entries => entries.at(-1).status === 'approved');
  assert.equal(history.at(-1).reply, 'Group the first two terms.');
  assert.equal(history.at(-1).simulated, false);
  assert.equal(history.at(-1).generationFailed, undefined);
  assert.equal(calls.length, 3);
  for (const { path, method, body } of calls) {
    assert.equal(path, '/api/chat');
    assert.equal(method, 'POST');
    assert.equal(body.model, 'qwen3:4b-instruct');
    assert.equal(body.stream, false);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /concisely/);
    assert.match(body.messages[0].content, /same language.*unless they explicitly ask for another language/);
    assert.deepEqual(body.messages[1], { role: 'user', content: text });
  }
});

test('allows an immediate revision when the teacher returns a prompt after generation fails', { timeout: 10000 }, async t => {
  const unavailableProvider = createServer((request, response) => {
    request.resume();
    response.writeHead(503).end();
  });
  unavailableProvider.listen(0, '127.0.0.1');
  await once(unavailableProvider, 'listening');
  t.after(() => new Promise(resolve => unavailableProvider.close(resolve)));

  const app = await start(t, {
    AI_MODE: 'ollama',
    OLLAMA_PORT: String(unavailableProvider.address().port),
  }, true);
  await app.advanceClock(60_000);
  const original = await app.submit('Can you solve the problem?');
  await app.decide(original.id, { action: 'approve' }, 202);

  const history = await waitFor(() => app.history(app.group), entries =>
    entries[0]?.status === 'pending' && entries[0].generationFailed,
  );
  assert.equal(history[0].reply, undefined);
  assert.deepEqual((await app.queue()).prompts, history);

  const feedback = 'Ask about the step where you are stuck.';
  const returned = await (await app.decide(original.id, { action: 'return', feedback }, 200)).json();
  assert.deepEqual(returned, { ...original, status: 'returned', feedback });

  const revised = await app.submit('How should we start finding the domain?');
  assert.equal(revised.status, 'pending');
  assert.deepEqual((await app.queue()).prompts, [revised]);
});

test('generates one reply when two teachers approve the same prompt concurrently', { timeout: 10000 }, async t => {
  let calls = 0;
  const provider = createServer((request, response) => {
    calls++;
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ message: { content: 'Try checking the domain.' } }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => new Promise(resolve => provider.close(resolve)));

  const app = await start(t, { AI_MODE: 'ollama', OLLAMA_PORT: String(provider.address().port) });
  const prompt = await app.submit('How should we start?');
  const approvals = await Promise.all([1, 2].map(() =>
    app.request('/api/prompts/' + prompt.id + '/decision', {
      body: { action: 'approve' },
      cookie: app.teacher,
      status: [202, 409],
    }),
  ));
  assert.deepEqual(approvals.map(response => response.status).sort(), [202, 409]);

  const history = await waitFor(() => app.history(app.group), entries => entries[0]?.status === 'approved');
  assert.equal(history[0].reply, 'Try checking the domain.');
  assert.equal(calls, 1);
});

test('restores the review queue and group history after signing in again', { timeout: 10000 }, async t => {
  const app = await start(t);
  const otherGroup = await app.join('group', app.groups[1]);
  const approved = await app.submit('How should we start?');
  await app.decide(approved.id, { action: 'approve' }, 202);
  const approvedHistory = await waitFor(() => app.history(app.group), entries =>
    entries[0]?.status === 'approved',
  );
  assert.ok(approvedHistory[0].reply);
  const pending = await app.submit('Can we check this step?', otherGroup);

  const reopenedTeacher = await app.join('teacher', app.key);
  const reopenedGroup = await app.join('group', app.groups[0]);
  const reopenedOtherGroup = await app.join('group', app.groups[1]);
  const recoveredQueue = await app.request('/api/teacher/prompts', { cookie: reopenedTeacher });

  assert.deepEqual(await recoveredQueue.json(), { groups: app.groups, prompts: [pending] });
  assert.deepEqual(await app.history(reopenedGroup), approvedHistory);
  assert.deepEqual(await app.history(reopenedOtherGroup), [pending]);
  await app.request('/api/prompts', {
    body: { text: 'What should we do next?' },
    cookie: reopenedGroup,
    status: 429,
  });
});

test('keeps the classroom responsive while one generation stalls and fails', { timeout: 10000 }, async t => {
  let releaseFailure;
  const stalled = new Promise(resolve => { releaseFailure = resolve; });
  const provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { messages } = JSON.parse(Buffer.concat(chunks));
    if (messages.at(-1).content === 'Slow request') {
      await stalled;
      response.writeHead(503).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ message: { content: 'Check where the function is defined.' } }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => {
    releaseFailure();
    provider.closeAllConnections();
    return new Promise(resolve => provider.close(resolve));
  });

  const app = await start(t, { AI_MODE: 'ollama', OLLAMA_PORT: String(provider.address().port) });
  const otherGroup = await app.join('group', app.groups[1]);
  const slow = await app.submit('Slow request');
  await app.decide(slow.id, { action: 'approve' }, 202);

  const fast = await app.submit('How do we start?', otherGroup);
  assert.deepEqual((await app.queue()).prompts, [fast]);
  await app.decide(fast.id, { action: 'approve' }, 202);
  const completed = await waitFor(() => app.history(otherGroup), entries => entries[0]?.status === 'approved');
  assert.equal(completed[0].reply, 'Check where the function is defined.');
  assert.deepEqual(await app.history(app.group), [{ ...slow, status: 'generating' }]);

  releaseFailure();
  const failed = await waitFor(() => app.history(app.group), entries => entries[0]?.generationFailed);
  assert.deepEqual(failed, [{ ...slow, generationFailed: true }]);
  assert.deepEqual((await app.queue()).prompts, failed);
  assert.deepEqual(await app.history(otherGroup), completed);
});
