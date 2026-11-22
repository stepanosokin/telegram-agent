import { randomUUID } from 'node:crypto';

const unavailable = 'Запрос Codex недоступен. Проверьте исходную сессию на компьютере.';
const unknown = 'Доставка ответа не подтверждена. Проверьте исходную сессию Codex на компьютере.';
const sent = 'Ответ отправлен. Запрос Codex закрыт. Итог проверьте в исходной сессии.';
const callbackPrefix = 'codex:';

function readQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length) return;
  const ids = new Set();
  for (const question of questions) {
    if (typeof question?.id !== 'string' || !question.id || ids.has(question.id)
      || typeof question.question !== 'string' || !question.question.trim() || question.isSecret !== false
      || !Array.isArray(question.options) || !question.options.length) return;
    // Codex also uses requestUserInput as a fallback for MCP tool approvals.
    if (question.id.startsWith('mcp_tool_call_approval_')) return;
    ids.add(question.id);
    const labels = new Set();
    for (const option of question.options) {
      if (typeof option?.label !== 'string' || !option.label.trim() || option.label.length > 64
        || typeof option.description !== 'string' || labels.has(option.label)) return;
      labels.add(option.label);
    }
  }
  return questions;
}

export function codexChoices(telegram, label) {
  const requests = new Map();
  const seen = new Set();
  const messages = new Map();
  const publications = new Map();

  async function finish(entry, status, details = '') {
    entry.status = status;
    if (entry.messageId === undefined) return;
    const prompt = messages.get(entry.messageId);
    messages.set(entry.messageId, { status, tokens: new Set(prompt.choices.keys()) });
    const summary = `${entry.header}\n\n${status}`;
    const text = summary.length + details.length <= 4096 ? summary + details : summary;
    await telegram.completeChoice(entry.messageId, text)
      .catch(() => console.error('Telegram не подтвердил обновление статуса запроса Codex.'));
  }

  function close(entry, resolution = false) {
    requests.delete(entry.id);
    if (entry.inFlight) entry.inFlight.resolve(resolution);
    else return finish(entry, unavailable);
  }

  function clear(threadId, matches = (turnId) => true) {
    for (const entry of requests.values()) {
      if ((threadId === undefined || entry.session.id === threadId) && matches(entry.turnId)) void close(entry);
    }
  }

  return {
    async publish(session, id, params, confirmTurn) {
      if (seen.has(id) || typeof params?.turnId !== 'string' || !params.turnId
        || typeof params.itemId !== 'string' || !params.itemId) return;
      seen.add(id);
      const header = label(session);
      const entry = { id, session, turnId: params.turnId, header, messageId: undefined, status: undefined, inFlight: undefined };
      requests.set(id, entry);
      if (!await confirmTurn(session, entry.turnId) || requests.get(id) !== entry) {
        if (requests.get(id) === entry) {
          requests.delete(id);
          await telegram.send(`${header}\n\n${unavailable}`);
        }
        return;
      }
      const questions = readQuestions(params.questions);
      const choices = new Map();
      const keyboard = [];
      const questionText = [];
      if (questions) {
        for (const [index, question] of questions.entries()) {
          const prefix = questions.length > 1 ? `${index + 1}. ` : '';
          questionText.push(`${prefix}${question.question}`,
            ...question.options.map(({ label, description }) => `• ${label}${description ? ` — ${description}` : ''}`));
          for (const { label } of question.options) {
            const callback_data = callbackPrefix + randomUUID();
            choices.set(callback_data, { questionId: question.id, label });
            keyboard.push([{ text: prefix + label, callback_data }]);
          }
        }
      }
      const body = `${header}\n\n${questionText.join('\n')}`;
      if (!questions || keyboard.length > 100 || body.length > 4096) {
        await telegram.send(`${header}\n\nДля запроса выбора Codex нужен ответ на компьютере.`);
        return;
      }

      const published = telegram.send(body, { keyboard }).then(async (message) => {
        if (!Number.isSafeInteger(message?.message_id) || message.message_id <= 0) return;
        entry.messageId = message.message_id;
        messages.set(entry.messageId, { entry, choices, answers: new Map(), count: questions.length });
        if (entry.status) await finish(entry, entry.status);
      });
      for (const token of choices.keys()) publications.set(token, published);
      try {
        await published;
      } finally {
        for (const token of choices.keys()) publications.delete(token);
      }
    },
    async handle(query, confirmTurn, respond) {
      if (!query.data.startsWith(callbackPrefix)) return false;
      await publications.get(query.data)?.catch(() => {});
      const answer = (text) => telegram.answerCallback(query.id, text).catch(() => {});
      const prompt = messages.get(query.message.message_id);
      if (!prompt) {
        await answer(unavailable);
        return true;
      }
      if (prompt.tokens) {
        await answer(prompt.tokens.has(query.data) ? prompt.status : unavailable);
        return true;
      }
      const { entry, choices, answers, count } = prompt;
      const choice = choices.get(query.data);
      if (!choice || entry.status || entry.inFlight) {
        await answer(choice ? (entry.status ?? 'Ответ уже отправляется в Codex.') : unavailable);
        return true;
      }
      if (!await confirmTurn(entry.session, entry.turnId) || requests.get(entry.id) !== entry) {
        if (requests.get(entry.id) === entry) await close(entry);
        await answer(unavailable);
        return true;
      }
      if (entry.inFlight) {
        await answer(entry.status ?? 'Ответ уже отправляется в Codex.');
        return true;
      }
      answers.set(choice.questionId, choice.label);
      if (answers.size < count) {
        await answer('Вариант выбран. Ответьте на остальные вопросы.');
        return true;
      }
      const inFlight = Promise.withResolvers();
      entry.inFlight = inFlight;
      const result = { answers: Object.fromEntries([...answers].map(([id, label]) => [id, { answers: [label] }])) };
      let timer;
      const deadline = new Promise((resolve) => { timer = setTimeout(resolve, 1500, false); });
      const writtenAndResolved = respond(entry.id, result).then(() => inFlight.promise, () => false);
      // This event confirms closure, which can also come from another client or turn cleanup.
      const status = await Promise.race([writtenAndResolved, deadline]) ? sent : unknown;
      clearTimeout(timer);
      if (requests.get(entry.id) === entry) requests.delete(entry.id);
      await answer(status);
      await finish(entry, status, `\nВаш выбор: ${[...answers.values()].join(', ')}`);
      return true;
    },
    resolve(threadId, id) {
      const entry = requests.get(id);
      if (entry?.session.id === threadId) return close(entry, true);
    },
    clearThread(threadId) { clear(threadId); },
    finishTurn(threadId, id) { clear(threadId, (turnId) => turnId === id); },
    startTurn(threadId, id) { clear(threadId, (turnId) => turnId !== id); },
  };
}
