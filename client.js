export function startClient() {
  const teacher = location.pathname === '/teacher';
  const role = teacher ? 'teacher' : 'group';
  document.documentElement.dataset.role = role;
  const access = document.querySelector('#access');
  const code = document.querySelector('#code');
  const codes = document.querySelector('#groups');
  const heading = document.querySelector('#heading');
  const form = document.querySelector('#submission');
  const input = document.querySelector('#prompt');
  const submit = form.querySelector('button');
  const list = document.querySelector('#prompts');
  const error = document.querySelector('#error');

  heading.textContent = teacher ? "Teacher's view" : "Group's view";
  access.querySelector('label').textContent = teacher ? 'Teacher key' : 'Group code';
  code.type = teacher ? 'password' : 'text';
  code.autocomplete = teacher ? 'current-password' : 'off';

  let lastRenderedPromptList = '';
  let actionInProgress = false;
  let groupHasOpenPrompt = false;
  let latestRefreshVersion = 0;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  async function request(path, body) {
    const options = body ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    } : { cache: 'no-store' };
    const response = await fetch(path, options);
    const data = await response.json();
    if (!response.ok) {
      const failure = new Error(data.error);
      failure.status = response.status;
      throw failure;
    }
    return data;
  }

  function createGroupPromptCard(prompt, canRevise) {
    const card = element('article', '');
    const status = {
      pending: 'Waiting for review',
      generating: 'Generating reply…',
      approved: 'Approved',
      returned: 'Returned',
    }[prompt.status];
    const statusHeading = element('h2', status, 'status status-' + prompt.status);
    if (prompt.status === 'generating') {
      statusHeading.textContent = 'Generating reply';
      statusHeading.setAttribute('aria-label', status);
      const dots = element('span', '...', 'generating-dots');
      dots.setAttribute('aria-hidden', 'true');
      statusHeading.append(dots);
    }
    card.append(statusHeading);
    card.append(element('p', prompt.text, 'prompt-text'));

    if (prompt.generationFailed) card.append(element('p', 'The reply failed to generate. Your teacher can retry.', 'muted'));
    if (prompt.feedback) card.append(element('h3', 'Teacher feedback'), element('p', prompt.feedback, 'prompt-text'));
    if (prompt.reply) {
      const reply = element('div', prompt.reply, 'ai-reply');
      document.defaultView.renderMathInElement?.(reply, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
          { left: '$', right: '$', display: false },
        ],
        output: 'mathml',
        errorCallback: () => {},
        trust: false,
      });
      card.append(element('h3', prompt.simulated ? 'Simulated AI reply' : 'AI reply'), reply);
    }
    if (canRevise && prompt.status === 'returned') {
      const revise = element('button', 'Revise prompt', 'secondary');
      revise.type = 'button';
      revise.addEventListener('click', () => {
        input.value = prompt.text;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
      card.append(revise);
    }
    return card;
  }

  function createTeacherPromptCard(prompt) {
    const card = element('article', '');
    card.append(element('h2', prompt.group));
    card.append(element('p', prompt.text, 'prompt-text'));

    if (prompt.generationFailed) card.append(element('p', 'Could not generate a reply. Check that Ollama is running and the model is installed.', 'muted'));
    const decision = document.createElement('form');
    const label = element('label', 'Feedback (optional)');
    const feedback = document.createElement('textarea');
    feedback.id = 'feedback-' + prompt.id;
    feedback.rows = 2;
    feedback.maxLength = 500;
    label.htmlFor = feedback.id;
    const approve = element('button', prompt.generationFailed ? 'Retry' : 'Approve');
    approve.value = 'approve';
    const returnPrompt = element('button', 'Return', 'secondary');
    returnPrompt.type = 'button';
    const actions = element('div', '', 'actions');
    actions.append(approve, returnPrompt);

    const returnPanel = element('div', '', 'return-panel');
    returnPanel.id = 'return-' + prompt.id;
    returnPanel.hidden = true;
    returnPrompt.setAttribute('aria-controls', returnPanel.id);
    returnPrompt.setAttribute('aria-expanded', 'false');

    const sendBack = element('button', 'Return to group');
    sendBack.value = 'return';
    const cancel = element('button', 'Cancel', 'secondary');
    cancel.type = 'button';
    const returnActions = element('div', '', 'actions');
    returnActions.append(sendBack, cancel);
    returnPanel.append(label, feedback, returnActions);
    decision.append(actions, returnPanel);

    function showReturn(open) {
      returnPanel.hidden = !open;
      actions.hidden = open;
      returnPrompt.setAttribute('aria-expanded', String(open));
      if (open) feedback.focus();
      else returnPrompt.focus();
    }

    returnPrompt.addEventListener('click', () => showReturn(true));
    cancel.addEventListener('click', () => showReturn(false));
    decision.addEventListener('submit', event => {
      event.preventDefault();
      if (actionInProgress) return;
      const action = event.submitter?.value;
      if (!action) return;
      performAction(async () => {
        await request('/api/prompts/' + prompt.id + '/decision', {
          action,
          feedback: feedback.value,
        });
      });
    });
    card.append(decision);
    return card;
  }

  async function refreshView() {
    const requestedVersion = ++latestRefreshVersion;
    let data;
    try {
      data = await request(teacher ? '/api/teacher/prompts' : '/api/prompts');
    } catch (failure) {
      if (requestedVersion !== latestRefreshVersion) return;
      if (failure.status !== 401) throw failure;
      access.hidden = false;
      form.hidden = true;
      codes.hidden = true;
      lastRenderedPromptList = '';
      list.replaceChildren();
      heading.textContent = teacher ? "Teacher's view" : "Group's view";
      return;
    }
    if (requestedVersion !== latestRefreshVersion) return;
    const { group, groups, prompts } = data;
    access.hidden = true;
    form.hidden = teacher;
    if (teacher && codes.hidden) {
      codes.querySelector('ul').replaceChildren(...groups.map(value => element('li', value)));
      codes.hidden = false;
    }
    if (!teacher) heading.textContent = 'Group ' + group + "'s view";
    groupHasOpenPrompt = prompts.some(prompt => prompt.status === 'pending' || prompt.status === 'generating');
    submit.disabled = actionInProgress || groupHasOpenPrompt;
    const visible = teacher ? prompts.filter(prompt => prompt.status === 'pending') : prompts.slice().reverse();
    renderPromptList(visible);
  }

  function renderPromptList(visible) {
    const state = JSON.stringify(visible);
    if (state === lastRenderedPromptList) return;
    lastRenderedPromptList = state;
    const existing = new Map([...list.children].map(card => [card.dataset.promptId, card]));
    const cards = visible.map((prompt, index) => {
      const canRevise = !teacher && index === 0;
      const key = JSON.stringify({ prompt, canRevise });
      const previous = existing.get(String(prompt.id));
      if (previous?.dataset.renderKey === key) return previous;
      const card = teacher
        ? createTeacherPromptCard(prompt)
        : createGroupPromptCard(prompt, canRevise);
      card.dataset.promptId = prompt.id;
      card.dataset.renderKey = key;
      return card;
    });
    const keep = new Set(cards);
    for (const card of [...list.children]) {
      if (!keep.has(card)) card.remove();
    }
    cards.forEach((card, index) => {
      if (list.children[index] !== card) list.insertBefore(card, list.children[index] ?? null);
    });
    if (teacher && !visible.length) list.append(element('p', 'No prompts waiting for review.', 'muted'));
  }

  async function performAction(action) {
    actionInProgress = true;
    latestRefreshVersion++;
    submit.disabled = true;
    error.textContent = '';
    try {
      await action();
      await refreshView();
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      actionInProgress = false;
      submit.disabled = groupHasOpenPrompt;
    }
  }

  access.addEventListener('submit', event => {
    event.preventDefault();
    if (actionInProgress) return;
    performAction(async () => {
      await request('/api/join', { role, code: code.value });
      code.value = '';
    });
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (actionInProgress || groupHasOpenPrompt) return;
    performAction(async () => {
      await request('/api/prompts', { text: input.value });
      input.value = '';
    });
  });

  async function pollForUpdates() {
    if (!actionInProgress) {
      try {
        await refreshView();
        if (error.textContent === 'Connection lost. Reconnecting…') error.textContent = '';
      } catch {
        error.textContent = 'Connection lost. Reconnecting…';
      }
    }
    setTimeout(pollForUpdates, 2_000);
  }

  pollForUpdates();
}
