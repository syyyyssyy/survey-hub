'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSurveyLogic } = require('../src/survey-logic');

const textQuestion = (qid, extra = {}) => ({ qid, type: 'text', title: qid, required: true, ...extra });
const singleQuestion = (qid, targetQid) => ({
  qid, type: 'single', title: qid, required: true,
  options: [{ id: 'A', text: 'A' }],
  jumpRules: [{ id: 'jump', when: { optionId: 'A' }, targetQid }]
});
const invalid = (error) => error.code === 'INVALID_SURVEY_LOGIC';

test('valid acyclic questions pass publication validation', () => {
  assert.equal(validateSurveyLogic([singleQuestion('entry', 'finish'), textQuestion('middle'), textQuestion('finish')]), true);
});

test('empty questions, duplicate ids, missing targets and self jumps are rejected', () => {
  for (const questions of [
    [],
    [textQuestion('same'), textQuestion('same')],
    [singleQuestion('start', 'missing')],
    [singleQuestion('start', 'start')]
  ]) assert.throws(() => validateSurveyLogic(questions), invalid);
});

test('cycles through jump and sequential edges are rejected', () => {
  assert.throws(() => validateSurveyLogic([singleQuestion('first', 'second'), singleQuestion('second', 'first')]), invalid);
  assert.throws(() => validateSurveyLogic([singleQuestion('first', 'third'), textQuestion('second'), singleQuestion('third', 'second')]), invalid);
});

test('duplicate option ids and mismatched rule conditions are rejected', () => {
  const duplicateOptions = { ...singleQuestion('pick', 'end'), options: [{ id: 'A', text: 'One' }, { id: 'A', text: 'Two' }] };
  const mismatched = { ...singleQuestion('pick', 'end'), jumpRules: [{ id: 'bad', when: { containsOptionId: 'A' }, targetQid: 'end' }] };
  for (const question of [duplicateOptions, mismatched]) {
    assert.throws(() => validateSurveyLogic([question, textQuestion('end')]), invalid);
  }
});

test('invalid multi-choice combinations and reversed numeric intervals are rejected', () => {
  const multi = { qid: 'pick', type: 'multi', title: 'Pick', required: true,
    options: [{ id: 'A', text: 'A' }, { id: 'B', text: 'B' }],
    jumpRules: [{ id: 'r1', when: { containsAllOptionIds: ['A', 'missing'] }, targetQid: 'end' }] };
  const duplicate = { ...multi, jumpRules: [{ id: 'r1', when: { exactOptionIds: ['A', 'A'] }, targetQid: 'end' }] };
  const conflictingLimit = { ...multi, jumpRules: [], validation: { minSelect: 2, exactSelect: 1 } };
  const number = { qid: 'age', type: 'number', title: 'Age', required: true,
    jumpRules: [{ id: 'r1', when: { op: 'between', min: 60, max: 18 }, targetQid: 'end' }] };
  const end = textQuestion('end');
  for (const item of [multi, duplicate, conflictingLimit, number]) assert.throws(() => validateSurveyLogic([item, end]), invalid);
});
