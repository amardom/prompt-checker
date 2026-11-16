import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(resolve(process.env.VIDEO_TOOLS || '.', 'package.json'));
const { chromium } = require('playwright-core');
const ffmpeg = require.resolve('@ffmpeg-installer/win32-x64/ffmpeg.exe');
const project = resolve(process.argv[2]);
const output = resolve(process.argv[3] || 'prompt-checker-v1.mp4');
const blueReplyFile = output.replace(/\.mp4$/i, '-reply.json');
const greenReplyFile = output.replace(/\.mp4$/i, '-green-reply.json');
const frames = mkdtempSync(join(tmpdir(), 'prompt-checker-frames-'));
const script = {
  initial: 'Solve ln(x − 1) + ln(5 − x) = 0 and sketch f(x) = ln(x − 1) + ln(5 − x).',
  green: 'For f(x) = ln(x − 1) + ln(5 − x), how do we find its domain before sketching the graph?',
  feedback: 'Please revise this prompt. Start with the first step we saw in class for sketching a function: finding its domain.',
  revised: 'To find the domain of f(x) = ln(x − 1) + ln(5 − x), we think both log arguments must be positive. How do we combine those conditions?',
};

let browser;
let app;
let replay;

try {
  const logs = [];
  let requestBody;
  let releaseReply;

  replay = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requestBody = JSON.parse(Buffer.concat(chunks).toString());
    try {
      const promptText = requestBody.messages.at(-1).content;
      const replyFile = promptText === script.green ? greenReplyFile : blueReplyFile;
      let recordedReply = existsSync(replyFile) ? JSON.parse(readFileSync(replyFile, 'utf8')) : undefined;
      if (!recordedReply) {
        const upstream = await fetch('http://127.0.0.1:11434/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(80_000),
        });
        if (!upstream.ok) throw Error(await upstream.text());
        recordedReply = await upstream.json();
        if (!recordedReply.message?.content?.trim()) throw Error('Ollama returned an empty reply.');
        writeFileSync(replyFile, JSON.stringify(recordedReply, null, 2));
      }
      await new Promise(resolve => { releaseReply = resolve; });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(recordedReply));
    } catch (error) {
      console.error(error.message);
      response.writeHead(502).end();
    }
  });
  replay.listen(0, '127.0.0.1');
  await once(replay, 'listening');

  app = spawn('powershell.exe', ['-NoProfile', '-Command', '& $env:DEMO_NODE $env:DEMO_ENTRY'], {
    env: { ...process.env, DEMO_NODE: process.execPath, DEMO_ENTRY: join(project, 'server.mts'), PORT: '0',
      HOST: '127.0.0.1', AI_MODE: 'ollama', OLLAMA_PORT: String(replay.address().port) },
    windowsHide: true,
  });
  app.stderr.on('data', chunk => process.stderr.write(chunk));
  app.stdout.on('data', chunk => logs.push(chunk.toString()));
  for (let i = 0; i < 80 && !logs.join('').includes('Teacher key: '); i++) await delay(100);
  const startup = logs.join('');
  const base = startup.match(/Group:\s+(http:\/\/[^\s]+)/)?.[1];
  const key = startup.match(/Teacher key: (\S+)/)?.[1];
  if (!base || !key) throw Error('Demo server did not start.');

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const composition = `<!doctype html><html lang="en"><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;background:#17241e;color:#f4f7f3;font:24px 'Segoe UI',sans-serif}
  header{padding:31px 52px 20px;display:flex;justify-content:space-between;align-items:center}
  strong{font-size:32px;letter-spacing:-.7px}small{color:#b6c8bd;font-size:17px}
  #intro,#terminal,#views{margin:0 52px}
  #intro{height:690px;padding:75px 86px;border-radius:18px;background:#f4f7f4;color:#17241e}
  #intro h1{font-size:60px;letter-spacing:-2px;margin:0 0 28px}
  #intro p{font-size:29px;max-width:1080px;line-height:1.5;margin:0 0 22px}
  #intro .equation{font:44px/1.3 Cambria,serif;margin:34px 0;padding:24px 32px;background:white;border-left:5px solid #215c43}#terminal{height:690px;background:#101913;border:1px solid #41584a;border-radius:18px;padding:38px 42px}
  #terminal strong{font-size:19px;color:#a8c8b5}pre{white-space:pre-wrap;font:23px/1.7 Consolas,monospace;color:#e6f1e9}
  #views{display:grid;grid-template-columns:1fr 1fr;gap:24px}.panel{border-radius:17px;overflow:hidden;background:#f4f7f4;color:#17241e}
  .panel:nth-child(2){background:#faf2e3}.label{font-size:19px;font-weight:700;padding:11px 23px;border-bottom:1px solid #17241e22}
  iframe{display:block;width:100%;height:650px;border:0}footer{padding:20px 52px;font-weight:600;font-size:23px}
  [hidden]{display:none!important}
  </style><header><strong>Prompt Checker</strong><small>Demo &nbsp;•&nbsp; Anjo Martínez</small></header>
  <section id="intro" hidden>
    <h1>Classroom task</h1>
    <p>Group Blue and Group Green are given the same function to sketch, following the steps covered in class.</p>
    <p class="equation">f(x) = ln(x − 1) + ln(5 − x)</p>
    <p>The groups can ask AI for help. The teacher reviews each prompt before it reaches the AI.</p>
  </section>
  <section id="terminal"><strong>Windows PowerShell</strong><pre id="command"></pre><pre id="startup"></pre></section>
  <section id="views" hidden><div class="panel"><div class="label">Group</div><iframe id="group" title="Group"></iframe></div><div class="panel"><div class="label">Teacher</div><iframe id="teacher" title="Teacher"></iframe></div></section><footer></footer></html>`;
  await page.route(base + '/recording', route => route.fulfill({ contentType: 'text/html', body: composition }));
  await page.goto(base + '/recording');
  const footer = page.locator('footer');
  const shots = [];
  async function caption(text) {
    await footer.evaluate((node, value) => { node.textContent = value; }, text);
  }
  async function shot(seconds) {
    const file = 'frame-' + shots.length + '.png';
    await page.screenshot({ path: join(frames, file), caret: 'hide' });
    shots.push({ file, seconds });
  }
  async function pauseBeforeClick(action) {
    await action.hover();
    await shot(1);
    await action.click();
  }
  async function type(locator, value, step, seconds) {
    for (let i = step; i < value.length; i += step) {
      await locator.fill(value.slice(0, i));
      await shot(seconds);
    }
    await locator.fill(value);
    await shot(seconds);
  }
  const command = 'PS> node .\\server.mts';
  const intro = page.locator('#intro');
  const terminal = page.locator('#terminal');
  await terminal.evaluate(node => { node.hidden = true; });
  await intro.evaluate(node => { node.hidden = false; });
  await shot(8);
  await intro.evaluate(node => { node.hidden = true; });
  await terminal.evaluate(node => { node.hidden = false; });
  await caption('The teacher starts the server from PowerShell.');
  for (let i = 4; i <= command.length + 2; i += 3) {
    await page.locator('#command').evaluate((node, value) => { node.textContent = value; }, command.slice(0, i));
    await shot(0.22);
  }
  await page.locator('#startup').evaluate((node, value) => { node.textContent = value; },
    startup.split(/\r?\n/).filter(line => /^(Group|Teacher):/.test(line)).join('\n'));
  await shot(4);
  await page.route(base + '/client.js', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const labeledSource = source
      .replace("element('h2', prompt.group)", "element('h2', 'Group ' + prompt.group)");
    await route.fulfill({ response, body: labeledSource });
  });
  await page.route(base + '/style.css', async route => {
    const response = await route.fetch();
    const css = await response.text();
    await route.fulfill({ response, body: css + '\nmain { margin-top: 1rem; }' });
  });
  await page.locator('#group').evaluate((node, url) => { node.src = url; }, base);
  await page.locator('#teacher').evaluate((node, url) => { node.src = url; }, base + '/teacher');
  await page.locator('#terminal').evaluate(node => { node.hidden = true; });
  await page.locator('#views').evaluate(node => { node.hidden = false; });

  const teacher = page.frameLocator('#teacher');
  const group = page.frameLocator('#group');
  const button = (view, name) => view.getByRole('button', { name, exact: true });
  await teacher.getByLabel('Teacher key').fill(key);
  await button(teacher, 'Continue').click();
  await teacher.getByText('Group codes', { exact: true }).waitFor();
  const codes = await page.request.get(base + '/api/teacher/prompts');
  const { groups } = await codes.json();
  await group.getByLabel('Group code').fill(groups[0]);
  await button(group, 'Continue').click();
  await group.getByRole('heading', { name: "Group Blue's view", exact: true }).waitFor();
  const blueCookie = (await page.context().cookies(base)).find(cookie => cookie.name === 'group');
  async function recordReply(readingTime) {
    const heading = group.getByRole('heading', { name: 'AI reply' });
    const scroll = await heading.evaluate(heading => {
      const reply = heading.nextElementSibling;
      for (const node of reply.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        node.textContent = node.textContent
          .replace(/[\u2018\u2019]/g, "'")
          .replace(/\*\*/g, '')
          .replace(/^\s*(?:---|#{1,6} )/gm, '');
      }
      reply.style.whiteSpace = 'pre-line';
      reply.style.fontSize = '15px';
      const view = heading.ownerDocument.defaultView;
      const previousStart = Math.max(0, heading.getBoundingClientRect().top + view.scrollY - 22);
      const bottom = Math.max(previousStart, reply.getBoundingClientRect().bottom + view.scrollY - view.innerHeight + 24);
      view.scrollTo(0, 0);
      return { start: view.scrollY, end: bottom, previousStart };
    });

    const distance = Math.max(0, scroll.end - scroll.start);
    if (!distance) {
      await shot(readingTime);
      return;
    }

    await shot(3);
    const steps = Math.ceil(distance / 10);
    const previousDistance = scroll.end - scroll.previousStart;
    const previousDuration = Math.max(readingTime - 6, previousDistance / 50);
    const scrollSpeed = previousDistance > 0 ? previousDistance / previousDuration : 50;
    const scrollDuration = distance / (scrollSpeed * 3);
    for (let step = 1; step <= steps; step++) {
      const position = scroll.start + distance * step / steps;
      await heading.evaluate((node, offset) => node.ownerDocument.defaultView.scrollTo(0, offset), position);
      await shot(scrollDuration / steps);
    }
    await shot(3);
  }
  const editor = group.getByLabel('Your prompt');
  await group.getByRole('heading', { name: "Group Blue's view", exact: true }).waitFor();
  const groupLabel = page.locator('#views .label').first();
  await groupLabel.evaluate(node => { node.textContent = 'Group Blue'; });
  async function showGroup(cookie, name) {
    await page.context().addCookies([cookie]);
    await page.locator('#group').evaluate(node => { node.contentWindow.location.reload(); });
    await group.getByRole('heading', { name: 'Group ' + name + "'s view", exact: true }).waitFor();
    await groupLabel.evaluate((node, label) => { node.textContent = label; }, 'Group ' + name);
  }
  await caption('Group Blue asks the AI to solve the entire problem.');
  await editor.fill('');
  await shot(2);
  await type(editor, script.initial, 7, 0.35);
  await pauseBeforeClick(button(group, 'Send for review'));
  await teacher.getByText(script.initial, { exact: true }).waitFor();
  await shot(3);

  const greenSession = await fetch(base + '/api/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'group', code: groups[1] }),
  });
  if (!greenSession.ok) throw Error('Green could not join.');
  const greenToken = greenSession.headers.get('set-cookie').split(';')[0].slice('group='.length);
  await showGroup({ ...blueCookie, value: greenToken }, 'Green');
  await caption('Group Green starts with the domain, the first step discussed in class.');
  await editor.fill('');
  await shot(1);
  await type(editor, script.green, 7, 0.35);
  await pauseBeforeClick(button(group, 'Send for review'));
  await teacher.getByText(script.green, { exact: true }).waitFor();
  await caption('Both prompts appear in the teacher\'s review queue.');
  await shot(5);

  await showGroup(blueCookie, 'Blue');
  const teacherCard = name => teacher.locator('article').filter({
    has: teacher.getByRole('heading', { name: 'Group ' + name, exact: true }),
  });
  const blueCard = teacherCard('Blue');
  await caption('The teacher returns Group Blue\'s prompt and points to the first step.');
  await pauseBeforeClick(button(blueCard, 'Return'));
  await shot(1);
  await type(blueCard.getByLabel('Feedback (optional)'), script.feedback, 8, 0.36);
  await shot(3);
  await pauseBeforeClick(button(blueCard, 'Return to group'));
  await button(group, 'Revise prompt').waitFor();
  await shot(4);

  await caption('Group Blue reformulates the question around the domain.');
  await pauseBeforeClick(button(group, 'Revise prompt'));
  await editor.fill('');
  await shot(1);
  await type(editor, script.revised, 8, 0.36);
  await shot(3);
  await pauseBeforeClick(button(group, 'Send for review'));
  await teacher.getByText(script.revised, { exact: true }).waitFor();
  await shot(3);
  await caption('The teacher approves Group Blue\'s revised prompt.');
  await pauseBeforeClick(button(blueCard, 'Approve'));
  await group.getByRole('heading', { name: 'Generating reply…' }).waitFor();
  await shot(3);
  for (let i = 0; i < 320 && !releaseReply; i++) await delay(250);
  if (!releaseReply) throw Error('Ollama reply did not arrive.');
  if (requestBody.messages.at(-1).content !== script.revised) throw Error('Unexpected prompt sent to Ollama.');
  releaseReply();
  releaseReply = undefined;
  await caption('Group Blue receives the AI response via Ollama.');
  await recordReply(8);

  await showGroup({ ...blueCookie, value: greenToken }, 'Green');
  await caption('Group Green\'s first prompt is ready to approve.');
  await group.getByRole('heading', { name: 'Waiting for review' }).waitFor();
  await shot(4);
  await pauseBeforeClick(button(teacherCard('Green'), 'Approve'));
  await group.getByRole('heading', { name: 'Generating reply…' }).waitFor();
  await caption('The teacher approves Group Green\'s first prompt.');
  await shot(3);
  for (let i = 0; i < 320 && !releaseReply; i++) await delay(250);
  if (!releaseReply) throw Error('Group Green\'s Ollama reply did not arrive.');
  if (requestBody.messages.at(-1).content !== script.green) throw Error('Unexpected Group Green prompt.');
  releaseReply();
  await teacher.getByText('No prompts waiting for review.').waitFor();
  await caption('Group Green receives the AI response via Ollama.');
  await recordReply(12);
  const list = shots.map(({ file, seconds }) => "file '" + file + "'\nduration " + seconds).join('\n');
  writeFileSync(join(frames, 'frames.txt'), list + "\nfile '" + shots.at(-1).file + "'\n");
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0',
    '-i', 'frames.txt', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output],
    { cwd: frames, stdio: 'inherit', windowsHide: true });
  console.log(output);
} finally {
  await browser?.close();
  if (app?.pid) {
    try { execFileSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
  replay?.closeAllConnections();
  replay?.close();
  rmSync(frames, { recursive: true, force: true });
}