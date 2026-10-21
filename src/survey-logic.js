'use strict';

const { question: questionSchema } = require('./schemas');

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_SURVEY_LOGIC';
  error.status = 400;
  throw error;
}

function validateSurveyLogic(questions) {
  if (!Array.isArray(questions) || questions.length === 0) invalid('Survey needs at least one question');
  const ids = new Set();
  for (const item of questions) {
    if (!questionSchema.safeParse(item).success) invalid('Invalid question');
    if (ids.has(item.qid)) invalid(`Duplicate question id: ${item.qid}`);
    ids.add(item.qid);
  }

  const edges = new Map();
  for (const [index, item] of questions.entries()) {
    const targets = (item.jumpRules || []).map((rule) => rule.targetQid);
    if (index + 1 < questions.length) targets.push(questions[index + 1].qid);
    for (const target of targets) {
      if (!ids.has(target)) invalid(`Unknown jump target: ${target}`);
      if (target === item.qid) invalid(`Question jumps to itself: ${item.qid}`);
    }
    edges.set(item.qid, targets);
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(qid) {
    if (visiting.has(qid)) invalid('Jump rules contain a cycle');
    if (visited.has(qid)) return;
    visiting.add(qid);
    for (const target of edges.get(qid)) visit(target);
    visiting.delete(qid);
    visited.add(qid);
  }
  for (const qid of ids) visit(qid);
  return true;
}

module.exports = { validateSurveyLogic };
