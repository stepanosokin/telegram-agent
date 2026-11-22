import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const prefix = 'form:';
const closed = 'Форма OpenCode недоступна. Проверьте исходную сессию на компьютере.';
const accepted = 'OpenCode принял ответ.';
const unknown = 'OpenCode не подтвердил ответ. Проверьте форму на компьютере перед повтором.';
const instructions = 'Выберите варианты, затем нажмите «Отправить ответ».';

function readFields(form) {
  if (!Array.isArray(form.fields) || !form.fields.length) return;
  const keys = new Set();
  for (const field of form.fields) {
    if (!['string', 'multiselect'].includes(field?.type)
      || typeof field.key !== 'string' || !field.key || keys.has(field.key)
      || field.hidden || field.when?.length || field.format || field.pattern
      || field.minLength !== undefined || field.maxLength !== undefined
      || !Array.isArray(field.options) || !field.options.length) return;
    const values = new Set();
    const labels = new Set();
    for (const option of field.options) {
      if (typeof option?.value !== 'string' || values.has(option.value)
        || typeof option.label !== 'string' || !option.label.trim() || labels.has(option.label)
        || option.label.length > 56) return;
      values.add(option.value);
      labels.add(option.label);
    }
    if (field.default !== undefined) {
      const selected = field.type === 'string' ? [field.default] : field.default;
      if (!Array.isArray(selected) || selected.some((value) => !values.has(value))
        || new Set(selected).size !== selected.length) return;
    }
    keys.add(field.key);
  }
  return form.fields;
}

function formKeyboard(entry) {
  return Array.from(entry.tokens, ([callback_data, option]) => {
    if (!option) return [{ text: 'Отправить ответ', callback_data }];
    const { field, index, value, label } = option;
    const selected = entry.answers.get(field.key);
    const active = Array.isArray(selected) ? selected.includes(value) : selected === value;
    return [{ text: `${active ? '✓ ' : ''}${index + 1}. ${label}`, callback_data }];
  });
}

function selectedValues(field, value, previous) {
  if (field.type === 'string') return value === previous ? undefined : value;
  const selected = new Set(Array.isArray(previous) ? previous : []);
  if (!selected.delete(value)) selected.add(value);
  return field.options.filter((option) => selected.has(option.value)).map((option) => option.value);
}

function hasCompleteAnswer({ fields, answers }) {
  return fields.every((field) => {
    const answer = answers.get(field.key);
    if (answer === undefined) return !field.required;
    if (field.type === 'string') return true;
    return answer.length >= Math.max(field.required ? 1 : 0, field.minItems ?? 0)
      && answer.length <= (field.maxItems ?? field.options.length);
  });
}

export function openCodeForms(telegram, label, buttonState) {
  const requests = new Map();
  const messages = new Map();
  const publications = new Map();
  const settled = new Set();

  function requestKey(sessionId, formId) {
    return JSON.stringify([sessionId, formId]);
  }

  function edit(entry, text, keyboard, error) {
    const applied = entry.edits.then(() => telegram.editChoice(entry.messageId, text, keyboard))
      .then(() => true, () => {
        console.error(error);
        return false;
      });
    entry.edits = applied;
    return applied;
  }

  async function finish(entry, status, details = '') {
    entry.status = status;
    requests.delete(entry.key);
    settled.add(entry.key);
    if (entry.messageId === undefined) return;
    messages.set(entry.messageId, { status, tokens: new Set(entry.tokens.keys()) });
    const summary = `${entry.header}\n\n${status}`;
    const text = summary.length + details.length <= 4096 ? summary + details : summary;
    await buttonState.complete(entry.messageId, status === accepted ? 'accepted' : status === unknown ? 'unknown' : 'closed',
      () => edit(entry, text, [], 'Telegram не подтвердил обновление формы OpenCode.'));
  }

  return {
    async publish(session, formId, connection, confirmSession) {
      if (typeof formId !== 'string' || !formId) return;
      const key = requestKey(session.id, formId);
      if (requests.has(key) || settled.has(key)) return;
      const current = await connection.readForm(session.id, formId).catch((error) => {
        if (!['FormNotFoundError', 'SessionNotFoundError'].includes(error?.name)) throw error;
      });
      if (!confirmSession() || current?.id !== formId || current.sessionID !== session.id
        || current.state?.status !== 'pending' || requests.has(key) || settled.has(key)) return;
      const header = `${label(session)}\n\n${current.title}`;
      const fields = readFields(current);
      const tokens = new Map();
      const questions = [];
      for (const [index, field] of (fields ?? []).entries()) {
        questions.push(`${index + 1}. ${field.title || field.key}${field.type === 'multiselect' ? ' (несколько вариантов)' : ''}`);
        if (field.description) questions.push(field.description);
        for (const { label, value, description } of field.options) {
          questions.push(`• ${label}${description ? ` — ${description}` : ''}`);
          tokens.set(prefix + randomUUID(), { field, index, value, label });
        }
      }
      tokens.set(prefix + randomUUID(), undefined);
      const text = `${header}\n${questions.join('\n')}\n\n${instructions}`;
      if (!fields || tokens.size > 100 || text.length > 4096) {
        settled.add(key);
        await telegram.send(`${label(session)}\n\nОтветьте на форму OpenCode в исходной сессии на компьютере.`);
        return;
      }
      const entry = {
        key, session, formId, connection, confirmSession, header, title: current.title, fields, tokens, text,
        answers: new Map(fields.filter((field) => field.default !== undefined).map((field) => [field.key, field.default])),
        messageId: undefined, status: undefined, inFlight: false, closed: false,
        edits: Promise.resolve(true), displayConfirmed: true,
      };
      requests.set(key, entry);
      const published = buttonState.publish('form', session, formId, current, text, formKeyboard(entry),
        () => confirmSession() && requests.get(key) === entry && !entry.closed).then(async (message) => {
        if (!Number.isSafeInteger(message?.message_id) || message.message_id <= 0) return;
        entry.messageId = message.message_id;
        messages.set(entry.messageId, { entry });
        if (entry.status) await finish(entry, entry.status);
      });
      for (const token of tokens.keys()) publications.set(token, published);
      try {
        await published;
      } catch (error) {
        if (requests.get(key) === entry) requests.delete(key);
        throw error;
      } finally {
        for (const token of tokens.keys()) publications.delete(token);
      }
    },
    async handle(query) {
      if (!query.data.startsWith(prefix)) return false;
      await publications.get(query.data)?.catch(() => {});
      const answer = (text) => telegram.answerCallback(query.id, text).catch(() => {});
      const prompt = messages.get(query.message.message_id);
      if (!prompt?.entry) {
        await answer(prompt?.tokens.has(query.data) ? prompt.status : buttonState.callbackStatus(query.message.message_id, 'form') ?? closed);
        return true;
      }
      const { entry } = prompt;
      if (!entry.tokens.has(query.data)) {
        await answer(buttonState.callbackStatus(query.message.message_id, 'form') ?? closed);
        return true;
      }
      const isOpen = () => !entry.closed && entry.confirmSession() && requests.get(entry.key) === entry;
      const current = await entry.connection.readForm(entry.session.id, entry.formId).catch(() => undefined);
      if (!isOpen() || current?.id !== entry.formId || current.sessionID !== entry.session.id
        || current.state?.status !== 'pending' || current.title !== entry.title
        || !isDeepStrictEqual(readFields(current), entry.fields)) {
        if (requests.get(entry.key) === entry) await finish(entry, closed);
        await answer(closed);
        return true;
      }
      const option = entry.tokens.get(query.data);
      if (option) {
        const { field, value } = option;
        const selected = selectedValues(field, value, entry.answers.get(field.key));
        if (Array.isArray(selected) && selected.length > (field.maxItems ?? field.options.length)) {
          await answer('Достигнуто максимальное число вариантов для вопроса.');
          return true;
        }
        if (selected === undefined || (Array.isArray(selected) && !selected.length)) entry.answers.delete(field.key);
        else entry.answers.set(field.key, selected);
        entry.displayConfirmed = false;
        await answer('Обновляю выбор…');
        if (isOpen()) {
          entry.displayConfirmed = await edit(entry, entry.text, formKeyboard(entry),
            'Telegram не подтвердил обновление выбора OpenCode.');
        }
        return true;
      }
      if (!entry.displayConfirmed) {
        await answer('Выбор в Telegram не подтверждён. Обновите выбор или ответьте на компьютере.');
        return true;
      }
      if (!hasCompleteAnswer(entry)) {
        await answer('Выберите допустимое число вариантов для каждого обязательного вопроса.');
        return true;
      }
      entry.inFlight = true;
      if (!await buttonState.begin(entry.messageId).catch(() => false)) {
        await finish(entry, unknown).catch(() => {});
        await answer(unknown);
        return true;
      }
      const result = await entry.connection.replyForm(entry.session.id, entry.formId, Object.fromEntries(entry.answers), isOpen);
      const status = result === 'accepted' ? accepted : result === 'closed' ? closed : unknown;
      const details = entry.fields.flatMap((field) => {
        const answer = entry.answers.get(field.key);
        const values = Array.isArray(answer) ? answer : [answer];
        const labels = field.options.filter((option) => values.includes(option.value)).map((option) => option.label);
        return labels.length ? [`${field.title || field.key}: ${labels.join(', ')}`] : [];
      });
      await answer(status);
      await finish(entry, status, result === 'accepted' && details.length ? `\n\n${details.join('\n')}` : '');
      return true;
    },
    close(sessionId, formId) {
      if (formId !== undefined) settled.add(requestKey(sessionId, formId));
      for (const entry of requests.values()) {
        if ((sessionId === undefined || entry.session.id === sessionId)
          && (formId === undefined || entry.formId === formId)) {
          entry.closed = true;
          if (!entry.inFlight) void finish(entry, closed);
        }
      }
    },
    suspend() {
      for (const entry of requests.values()) entry.closed = true;
      requests.clear();
      messages.clear();
      settled.clear();
    },
  };
}
