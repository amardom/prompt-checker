import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { generateReply } from './ai-replies.mts';

type SessionIdentity = { role: 'teacher' } | { role: 'group'; group: string };

type Prompt = {
  id: number;
  group: string;
  text: string;
  status: 'pending' | 'generating' | 'approved' | 'returned';
  feedback?: string;
  reply?: string;
  simulated?: boolean;
  generationFailed?: boolean;
};

const prompts: Prompt[] = [];
const submissionCooldownMs = 4 * 60 * 1_000;
const lastApprovalByGroup = new Map<string, number>();

async function generateApprovedReply(prompt: Prompt, approvedAt: number) {
  try {
    const reply = await generateReply(prompt.text);
    prompt.reply = reply.text;
    prompt.simulated = reply.simulated;
    lastApprovalByGroup.set(prompt.group, approvedAt);
    prompt.status = 'approved';
  } catch (error) {
    console.error('Could not generate a reply:', error instanceof Error ? error.message : 'Unknown error');
    prompt.status = 'pending';
    prompt.generationFailed = true;
  }
}
const groupNamesByCode = new Map(['Blue', 'Green', 'Orange', 'Purple', 'Red', 'Yellow'].map(name => [
  name.toUpperCase() + '-' + randomBytes(3).toString('hex').toUpperCase(), name,
]));
const teacherKey = randomBytes(12).toString('hex');
const sessions = new Map<string, SessionIdentity>();
const page = readFileSync(new URL('./index.html', import.meta.url));
const client = readFileSync(new URL('./client.js', import.meta.url));
const css = readFileSync(new URL('./style.css', import.meta.url));
const katex = readFileSync(new URL('./vendor/katex.min.js', import.meta.url));
const mathAutoRender = readFileSync(new URL('./vendor/auto-render.min.js', import.meta.url));

const server = createServer(async (request, response) => {
  const path = request.url;
  const method = request.method;

  function send(status: number, body: unknown, cookie?: string) {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(cookie ? { 'Set-Cookie': cookie } : {}),
    });
    response.end(JSON.stringify(body));
  }

  function session(role: 'teacher' | 'group') {
    const token = request.headers.cookie?.split('; ').find(entry => entry.startsWith(role + '='));
    const identity = token && sessions.get(token.slice(role.length + 1));
    return identity && identity.role === role ? identity : undefined;
  }

  if (method === 'GET') {
    const assets = {
      '/': ['text/html', page],
      '/teacher': ['text/html', page],
      '/client.js': ['text/javascript', client],
      '/style.css': ['text/css', css],
      '/vendor/katex.min.js': ['text/javascript', katex],
      '/vendor/auto-render.min.js': ['text/javascript', mathAutoRender],
    } as const;
    if (path && Object.hasOwn(assets, path)) {
      const [type, content] = assets[path as keyof typeof assets];
      response.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      return response.end(content);
    }
    if (path === '/api/teacher/prompts') {
      if (!session('teacher')) return send(401, { error: 'Enter the teacher key.' });
      return send(200, { groups: [...groupNamesByCode.keys()], prompts: prompts.filter(prompt => prompt.status === 'pending') });
    }
    if (path === '/api/prompts') {
      const identity = session('group');
      if (identity?.role !== 'group') return send(401, { error: 'Enter your group code.' });
      return send(200, { group: identity.group, prompts: prompts.filter(prompt => prompt.group === identity.group) });
    }
  }

  const decision = path?.match(/^\/api\/prompts\/(\d+)\/decision$/);
  if (method !== 'POST' || (path !== '/api/prompts' && path !== '/api/join' && !decision)) {
    return send(404, { error: 'Not found.' });
  }

  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    return send(415, { error: 'Expected JSON.' });
  }

  let body = '';
  try {
    for await (const chunk of request.setEncoding('utf8').iterator({ destroyOnReturn: false })) {
      body += chunk;
      if (body.length > 16_000) {
        request.resume();
        return send(413, { error: 'Request is too large.' });
      }
    }
  } catch {
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return send(400, { error: 'Invalid request.' });
  }
  if (!data || typeof data !== 'object') return send(400, { error: 'Invalid request.' });

  const payload = data as Record<string, unknown>;
  if (path === '/api/join') return joinSession(payload);
  if (path === '/api/prompts') return submitPrompt(payload);
  return reviewPrompt(Number(decision?.[1]), payload);

  function joinSession(data: Record<string, unknown>) {
    if (typeof data.code !== 'string') return send(400, { error: 'Enter an access code.' });
    const code = data.code.trim();
    const group = groupNamesByCode.get(code.toUpperCase());
    let identity: SessionIdentity | undefined;
    if (data.role === 'teacher' && code === teacherKey) {
      identity = { role: 'teacher' };
    } else if (data.role === 'group' && group) {
      identity = { role: 'group', group };
    }
    if (!identity) return send(403, { error: 'Incorrect access code.' });
    const token = randomBytes(24).toString('hex');
    const previous = request.headers.cookie?.split('; ').find(entry => entry.startsWith(identity.role + '='));
    if (previous) sessions.delete(previous.slice(identity.role.length + 1));
    sessions.set(token, identity);
    return send(200, {}, identity.role + '=' + token + '; HttpOnly; SameSite=Strict; Path=/');
  }

  function submitPrompt(data: Record<string, unknown>) {
    const identity = session('group');
    if (identity?.role !== 'group') return send(401, { error: 'Enter your group code.' });
    if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 2_000) {
      return send(400, { error: 'Enter a prompt of up to 2,000 characters.' });
    }
    const groupHasOpenPrompt = prompts.some(prompt =>
      prompt.group === identity.group && (prompt.status === 'pending' || prompt.status === 'generating'),
    );
    if (groupHasOpenPrompt) {
      return send(409, { error: 'A prompt is already waiting for review.' });
    }
    const lastApproval = lastApprovalByGroup.get(identity.group);
    if (lastApproval !== undefined && Date.now() - lastApproval < submissionCooldownMs) {
      return send(429, { error: 'Wait four minutes after your last approved prompt before sending another.' });
    }

    const prompt: Prompt = {
      id: prompts.length + 1,
      group: identity.group,
      text: data.text,
      status: 'pending',
    };
    prompts.push(prompt);
    return send(201, prompt);
  }

  function reviewPrompt(promptId: number, data: Record<string, unknown>) {
    if (!session('teacher')) return send(401, { error: 'Enter the teacher key.' });
    const prompt = prompts.find(entry => entry.id === promptId);
    if (!prompt) return send(404, { error: 'Prompt not found.' });
    if (prompt.status !== 'pending') return send(409, { error: 'This prompt has already been reviewed.' });
    if (data.action === 'approve') {
      delete prompt.generationFailed;
      const approvedAt = Date.now();
      prompt.status = 'generating';
      send(202, prompt);
      void generateApprovedReply(prompt, approvedAt);
      return;
    }

    if (data.action !== 'return' || typeof data.feedback !== 'string' || data.feedback.length > 500) {
      return send(400, { error: 'Invalid decision.' });
    }

    delete prompt.generationFailed;
    prompt.status = 'returned';
    prompt.feedback = data.feedback.trim();
    return send(200, prompt);
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  const address = server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : port;
  console.log('Group:   http://127.0.0.1:' + listeningPort);
  console.log('Teacher: http://127.0.0.1:' + listeningPort + '/teacher');
  console.log('Teacher key: ' + teacherKey);
});