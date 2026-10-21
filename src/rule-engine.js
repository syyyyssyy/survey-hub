'use strict';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function validateAnswer(question, answer) {
  const qid = question.qid;
  if (answer === undefined) {
    if (question.required) fail('VALIDATION_ERROR', `Missing required answer: ${qid}`);
    return true;
  }
  if (!answer || answer.qid !== qid || answer.type !== question.type) {
    fail('VALIDATION_ERROR', `Answer does not match question: ${qid}`);
  }

  const value = answer.value;
  const validation = question.validation || {};
  if (value === null || value === undefined) {
    fail('VALIDATION_ERROR', `Invalid value for ${qid}`);
  }
  const isEmpty = (question.type === 'text' && typeof value === 'string' && value.trim() === '') ||
    (question.type === 'multi' && Array.isArray(value) && value.length === 0);
  if (isEmpty) {
    if (question.required) fail('VALIDATION_ERROR', `Missing required answer: ${qid}`);
    return true;
  }

  switch (question.type) {
    case 'single': {
      if (typeof value !== 'string' || !question.options?.some((option) => option.id === value)) {
        fail('VALIDATION_ERROR', `Invalid option for ${qid}`);
      }
      break;
    }
    case 'multi': {
      const allowed = new Set((question.options || []).map((option) => option.id));
      if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !allowed.has(id)) ||
          new Set(value).size !== value.length ||
          (validation.exactSelect != null && value.length !== validation.exactSelect) ||
          (validation.minSelect != null && value.length < validation.minSelect) ||
          (validation.maxSelect != null && value.length > validation.maxSelect)) {
        fail('VALIDATION_ERROR', `Invalid selection for ${qid}`);
      }
      break;
    }
    case 'text': {
      if (typeof value !== 'string' ||
          (validation.minLength != null && value.length < validation.minLength) ||
          (validation.maxLength != null && value.length > validation.maxLength)) {
        fail('VALIDATION_ERROR', `Invalid text for ${qid}`);
      }
      break;
    }
    case 'number':
    case 'rating': {
      if (typeof value !== 'number' || !Number.isFinite(value) ||
          (validation.min != null && value < validation.min) ||
          (validation.max != null && value > validation.max) ||
          (validation.integer === true && !Number.isInteger(value))) {
        fail('VALIDATION_ERROR', `Invalid number for ${qid}`);
      }
      break;
    }
    default:
      fail('INVALID_SURVEY_LOGIC', `Unsupported question type: ${question.type}`);
  }
  return true;
}

function resolveNextQuestion(questions, currentQid, answer) {
  const index = questions.findIndex((question) => question.qid === currentQid);
  if (index < 0) fail('INVALID_SURVEY_LOGIC', `Unknown question: ${currentQid}`);

  const question = questions[index];
  const value = answer?.value;
  for (const rule of question.jumpRules || []) {
    const when = rule.when;
    let matches = false;
    if (question.type === 'single' && Object.hasOwn(when, 'optionId')) {
      matches = value === when.optionId;
    } else if (question.type === 'multi' && Object.hasOwn(when, 'containsOptionId')) {
      matches = Array.isArray(value) && value.includes(when.containsOptionId);
    } else if (question.type === 'multi') {
      const selected = Array.isArray(value) ? value : [];
      if (when.containsAnyOptionIds) matches = when.containsAnyOptionIds.some((id) => selected.includes(id));
      else if (when.containsAllOptionIds) matches = when.containsAllOptionIds.every((id) => selected.includes(id));
      else if (when.exactOptionIds) matches = selected.length === when.exactOptionIds.length &&
        when.exactOptionIds.every((id) => selected.includes(id));
      else if (when.excludesOptionIds) matches = when.excludesOptionIds.every((id) => !selected.includes(id));
    } else if ((question.type === 'number' || question.type === 'rating') &&
        typeof value === 'number' && Number.isFinite(value)) {
      const comparisons = {
        gte: (left, right) => left >= right,
        gt: (left, right) => left > right,
        lte: (left, right) => left <= right,
        lt: (left, right) => left < right,
        eq: (left, right) => left === right
      };
      matches = when.op === 'between' ? value >= when.min && value <= when.max :
        comparisons[when.op]?.(value, when.value) === true;
    }
    if (matches) return rule.targetQid;
  }
  return questions[index + 1]?.qid ?? null;
}

function replayPath(questions, answers) {
  if (!Array.isArray(questions) || !Array.isArray(answers)) {
    fail('VALIDATION_ERROR', 'Questions and answers must be arrays');
  }
  const submitted = new Map();
  for (const answer of answers) {
    if (!answer || typeof answer.qid !== 'string') {
      fail('VALIDATION_ERROR', 'Each answer must have a qid');
    }
    if (submitted.has(answer.qid)) fail('VALIDATION_ERROR', `Duplicate answer: ${answer.qid}`);
    submitted.set(answer.qid, answer);
  }

  const path = [];
  const visited = new Set();
  const known = new Set(questions.map((question) => question.qid));
  let currentQid = questions[0]?.qid ?? null;
  while (currentQid !== null) {
    if (visited.has(currentQid) || !known.has(currentQid)) {
      fail('INVALID_SURVEY_LOGIC', `Invalid jump target or cycle: ${currentQid}`);
    }
    visited.add(currentQid);
    const question = questions.find((item) => item.qid === currentQid);
    const answer = submitted.get(currentQid);
    validateAnswer(question, answer);
    path.push(currentQid);
    currentQid = resolveNextQuestion(questions, currentQid, answer);
  }
  for (const qid of submitted.keys()) {
    if (!visited.has(qid)) fail('JUMP_PATH_MISMATCH', `Answer outside path: ${qid}`);
  }
  return path;
}

module.exports = { validateAnswer, resolveNextQuestion, replayPath };
