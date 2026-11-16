import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { startClient } from '../client.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const mathScripts = ['katex.min.js', 'auto-render.min.js'].map(file =>
  readFileSync(new URL('../vendor/' + file, import.meta.url), 'utf8'),
);

async function browser(t, path, fetch) {
  const { window } = new JSDOM(html, { url: 'http://localhost' + path, runScripts: 'outside-only' });
  for (const script of mathScripts) window.eval(script);
  const timers = [];
  const nativeTimeout = globalThis.setTimeout;
  const globals = {
    document: window.document,
    location: window.location,
    fetch,
    setTimeout: (callback, ms, ...args) => {
      if (callback.name === 'pollForUpdates' && ms === 2_000) return timers.push(callback);
      return nativeTimeout(callback, ms, ...args);
    },
  };
  const originals = Object.entries(globals).map(([key, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    return [key, descriptor];
  });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    window.close();
  });

  startClient();
  await setImmediate();
  const find = selector => window.document.querySelector(selector);
  function submit(selector, button) {
    find(selector).dispatchEvent(new window.SubmitEvent('submit', { cancelable: true, submitter: button }));
    return setImmediate();
  }
  async function poll() {
    assert.equal(timers.length, 1);
    await timers.shift()();
  }
  return { find, submit, poll };
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

test('group signs in, sends, revises, and sees generation, errors, and replies', async t => {
  let authorized = false;
  let offline = false;
  let prompts = [];
  const sent = [];
  const group = await browser(t, '/', async (path, options) => {
    if (offline) throw new Error('Offline');
    if (path === '/api/join') {
      const body = JSON.parse(options.body);
      assert.equal(body.role, 'group');
      if (body.code !== 'BLUE') return response({ error: 'Incorrect access code.' }, 403);
      authorized = true;
      return response({});
    }
    assert.equal(path, '/api/prompts');
    if (!authorized) return response({}, 401);
    if (options.method === 'POST') {
      const { text } = JSON.parse(options.body);
      sent.push(text);
      prompts.push({ id: prompts.length + 1, text, status: 'pending' });
    }
    return response({ group: 'Blue', prompts });
  });
  const { find, submit, poll } = group;
  const editor = find('#prompt');
  assert.equal(find('#access').hidden, false);
  find('#code').value = 'bad';
  await submit('#access');
  assert.equal(find('#error').textContent, 'Incorrect access code.');
  find('#code').value = 'BLUE';
  await submit('#access');
  assert.equal(find('#heading').textContent, "Group Blue's view");
  assert.equal(find('#submission').hidden, false);

  editor.value = 'Solve the whole problem.';
  await submit('#submission');
  assert.equal(editor.value, '');
  assert.equal(find('#submission button').disabled, true);
  assert.match(find('#prompts').textContent, /Waiting for review/);
  await submit('#submission');
  assert.equal(sent.length, 1);
  Object.assign(prompts[0], { status: 'returned', feedback: 'Ask for a hint.' });
  await poll();
  assert.match(find('#prompts').textContent, /Returned.*Ask for a hint/);
  find('article button').click();
  assert.equal(editor.value, sent[0]);
  assert.equal(editor.ownerDocument.activeElement, editor);
  editor.value = 'Can we get a hint?';
  await submit('#submission');
  assert.equal(find('article button'), null);
  assert.deepEqual(sent, ['Solve the whole problem.', 'Can we get a hint?']);

  Object.assign(prompts[1], { status: 'generating' });
  await poll();
  const generating = find('.status-generating');
  assert.equal(generating.getAttribute('aria-label'), 'Generating reply…');
  assert.equal(find('.generating-dots').textContent, '...');
  Object.assign(prompts[1], { status: 'pending', generationFailed: true });
  await poll();
  assert.match(find('#prompts').textContent, /Your teacher can retry/);
  prompts[1] = { ...prompts[1], status: 'approved', generationFailed: false, reply: String.raw`Try grouping $x^2$.
\[\frac{1}{2}\]
\(\unknownCommand\)`, simulated: false };
  await poll();
  assert.match(find('#prompts').textContent, /AI replyTry grouping/);
  assert.equal(find('.ai-reply math msup')?.localName, 'msup');
  assert.equal(find('.ai-reply math[display="block"] mfrac')?.localName, 'mfrac');
  assert.match(find('.ai-reply').textContent, /unknownCommand/);
  assert.equal(find('#submission button').disabled, false);
  prompts[1].simulated = true;
  await poll();
  assert.match(find('#prompts').textContent, /Simulated AI reply/);
  offline = true;
  await poll();
  assert.match(find('#error').textContent, /Reconnecting/);
  offline = false;
  await poll();
  assert.equal(find('#error').textContent, '');
  authorized = false;
  await poll();
  assert.equal(find('#submission').hidden, true);
  assert.equal(find('article'), null);
});

test('teacher can cancel feedback, keep a draft as new prompts arrive, and review or retry', async t => {
  const first = { id: 1, group: 'Blue', text: 'Solve this.', status: 'pending' };
  const second = { id: 2, group: 'Green', text: 'Give us a hint.', status: 'pending', generationFailed: true };
  let prompts = [first];
  let authorized = false;
  const decisions = [];
  const teacher = await browser(t, '/teacher', async (path, options) => {
    if (path === '/api/join') {
      assert.deepEqual(JSON.parse(options.body), { role: 'teacher', code: 'test-key' });
      authorized = true;
      return response({});
    }
    if (path.endsWith('/decision')) {
      decisions.push(JSON.parse(options.body));
      const id = Number(path.split('/')[3]);
      prompts = prompts.filter(prompt => prompt.id !== id);
      return response({});
    }
    assert.equal(path, '/api/teacher/prompts');
    return authorized ? response({ groups: ['BLUE', 'GREEN'], prompts }) : response({}, 401);
  });
  const { find, submit, poll } = teacher;
  assert.equal(find('#code').type, 'password');
  find('#code').value = 'test-key';
  await submit('#access');
  assert.equal(find('#groups').hidden, false);
  assert.equal(find('#submission').hidden, true);
  const toggle = find('article button.secondary');
  const panel = find('#return-1');
  const feedback = find('#feedback-1');
  assert.equal(panel.hidden, true);
  toggle.click();
  assert.equal(panel.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(feedback.ownerDocument.activeElement, feedback);
  find('#return-1 .secondary').click();
  assert.equal(panel.hidden, true);
  assert.equal(feedback.ownerDocument.activeElement, toggle);
  toggle.click();
  feedback.value = 'Ask for a hint.';
  prompts.push(second);
  await poll();
  assert.equal(find('#feedback-1'), feedback);
  assert.equal(feedback.value, 'Ask for a hint.');
  assert.equal(panel.hidden, false);
  assert.match(find('[data-prompt-id="2"]').textContent, /Retry/);
  await submit('[data-prompt-id="1"] form');
  assert.equal(decisions.length, 0);
  await submit('[data-prompt-id="1"] form', find('#return-1 button[value="return"]'));
  await submit('[data-prompt-id="2"] form', find('button[value="approve"]'));
  assert.deepEqual(decisions, [{ action: 'return', feedback: 'Ask for a hint.' }, { action: 'approve', feedback: '' }]);
  assert.equal(find('#prompts').textContent, 'No prompts waiting for review.');
});