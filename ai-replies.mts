const useSimulatedReply = process.env.AI_MODE === 'simulated';
const model = process.env.OLLAMA_MODEL || 'qwen3:4b-instruct';

export async function generateReply(text: string): Promise<{ text: string; simulated: boolean }> {
  if (useSimulatedReply) {
    return {
      text: 'Start by describing what you already know. Which of those facts could help you take the next step?',
      simulated: true,
    };
  }

  const ollamaPort = Number(process.env.OLLAMA_PORT ?? 11434);
  const result = await fetch('http://127.0.0.1:' + ollamaPort + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: 'Answer directly and concisely. Include the essential reasoning and omit repetition. Give more detail if the question requires it. Reply in the same language as the group\'s question, unless they explicitly ask for another language.' },
        { role: 'user', content: text },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!result.ok) throw new Error('Ollama returned HTTP ' + result.status);
  const data = await result.json();
  const reply = typeof data.message?.content === 'string' ? data.message.content.trim() : '';
  if (!reply) throw new Error('Ollama returned an empty reply.');
  return { text: reply, simulated: false };
}
